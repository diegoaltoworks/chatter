/**
 * Boots a real Chatter server and asserts what "does the widget actually get
 * served" can assert generically: `/healthz` responds, and `/chatter.js`
 * matches whichever outcome the caller expects.
 *
 * `createServer` is passed in rather than imported here, and the config
 * deliberately omits `staticDir`/`publicDir` so `resolveStatic`
 * (src/core/widgets.ts) falls back to the real built widget sitting next to
 * the running module — the actual file a consumer's install serves, not a
 * synthetic stand-in written into a tmpdir. That is the one thing this check
 * exists to prove: a regression that stopped `build:copy-client` from
 * shipping `dist/static/chatter.js` would otherwise pass every other gate.
 *
 * Shared verbatim by scripts/verify-node.mjs (imported in-process, against
 * the in-tree `dist/`) and scripts/verify-pack.ts (copied into a throwaway
 * npm consumer and run under real Node — Bun always has a `Bun` global, so it
 * would never take the Node-only static-adapter branch this exists to
 * exercise; see verify-pack.ts's docstring). No relative imports of its own,
 * so a plain file copy into the consumer is enough to make it runnable there.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * @param {(config: unknown) => Promise<{ request: typeof fetch; stopChannels: () => Promise<void> }>} createServer
 * @param {{ chatterJsStatus: number; expectActionableLog: boolean; retriever?: boolean }} spec
 */
export async function runBootCheck(createServer, spec) {
  const logs = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (...args) => logs.push(args.map(String).join(" ")),
    error: (...args) => logs.push(args.map(String).join(" ")),
  };

  const knowledgeDir = await mkdtemp(join(tmpdir(), "chatter-boot-"));
  try {
    const app = await createServer({
      bot: { name: "Boot Check", personName: "Tester", publicUrl: "http://localhost" },
      openai: { apiKey: "test-key-not-used" },
      // `spec.retriever` proves config.retriever works with no config.database
      // at all - the scenario that lets a consumer skip @libsql/client
      // entirely (see docs/patterns/adding-a-retriever.md). Every other
      // scenario keeps exercising the default VectorStore path.
      ...(spec.retriever
        ? { retriever: { query: async () => [] } }
        : { database: { url: "file::memory:", authToken: "" } }),
      knowledgeDir,
      features: { headless: false },
      logger,
    });

    const health = await app.request("/healthz");
    if (health.status !== 200) throw new Error(`/healthz returned ${health.status}`);

    const asset = await app.request("/chatter.js");
    if (asset.status !== spec.chatterJsStatus) {
      throw new Error(`/chatter.js returned ${asset.status}, expected ${spec.chatterJsStatus}`);
    }
    if (spec.chatterJsStatus === 200 && !(await asset.text()).includes("Chatter")) {
      throw new Error("/chatter.js did not serve the built widget bundle");
    }

    if (spec.expectActionableLog) {
      const actionable = logs.some(
        (line) => line.includes("@hono/node-server") && line.includes("headless"),
      );
      if (!actionable) {
        throw new Error(
          "static assets fell back to 404 with no actionable log — a Node consumer who forgot the " +
            "optional peer would see a silent failure instead of a fixable one",
        );
      }
    }

    await app.stopChannels();
  } finally {
    await rm(knowledgeDir, { recursive: true, force: true });
  }
}
