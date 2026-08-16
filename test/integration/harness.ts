/**
 * Shared harness for the createServer integration tests.
 *
 * The OpenAI SDK client `createServer` builds internally accepts no fetch
 * injection point, so faking it means intercepting the network boundary:
 * `globalThis.fetch` is swapped out for the duration of a test and any
 * request bound for api.openai.com is answered from here instead of going
 * out over the wire. Everything else (Turso, localhost) passes through to
 * the real fetch unchanged.
 *
 * Paired with an in-memory libsql database (`file::memory:`), this lets the
 * integration suite exercise the real `createServer` wiring — routing,
 * middleware, the RAG pipeline, streaming — without any external service or
 * API key.
 *
 * Call `installFakeOpenAI()` before `createServer(...)`: the OpenAI SDK
 * resolves `fetch` once, at client construction, so the fake has to be in
 * place before `createServer` builds its `OpenAI` client, not merely before
 * the first request.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatterConfig } from "../../src/types";

export interface FakeOpenAICall {
  path: string;
  body: Record<string, unknown> | undefined;
}

export interface FakeOpenAI {
  /** Every OpenAI request observed while this fake was installed. */
  calls: FakeOpenAICall[];
  /** Restores the original global fetch. Always call in `afterAll`. */
  restore(): void;
}

function embeddingResponse(input: unknown) {
  const count = Array.isArray(input) ? input.length : 1;
  // Deterministic, not random: same input text always yields the same
  // vector, so cosine-similarity ranking in tests is reproducible.
  const vector = (text: string) => {
    let seed = 0;
    for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) % 997;
    return [Math.sin(seed), Math.cos(seed)];
  };
  const texts = Array.isArray(input) ? input : [input];
  return {
    object: "list",
    data: Array.from({ length: count }, (_, i) => ({
      object: "embedding",
      index: i,
      embedding: vector(String(texts[i] ?? "")),
    })),
    model: "text-embedding-3-large",
    usage: { prompt_tokens: 1, total_tokens: 1 },
  };
}

function chatCompletionResponse(reply: string) {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 0,
    model: "gpt-4o-mini",
    choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function chatCompletionStream(reply: string): Response {
  const encoder = new TextEncoder();
  const chunk = (delta: Record<string, unknown>) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 0,
      model: "gpt-4o-mini",
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`;

  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(chunk({ role: "assistant", content: reply })));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Installs a fake `fetch` that answers OpenAI chat-completion and embedding
 * requests locally. `reply` is the assistant text every non-streaming and
 * streaming completion returns.
 */
export function installFakeOpenAI(opts: { reply?: string } = {}): FakeOpenAI {
  const reply = opts.reply ?? "faked reply";
  const originalFetch = globalThis.fetch;
  const calls: FakeOpenAICall[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (!url.includes("api.openai.com")) {
      return originalFetch(input, init);
    }

    const rawBody = input instanceof Request ? await input.clone().text() : (init?.body as string);
    const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined;
    const path = new URL(url).pathname;
    calls.push({ path, body });

    if (path.endsWith("/embeddings")) {
      return jsonResponse(embeddingResponse(body?.input));
    }

    if (path.endsWith("/chat/completions")) {
      if (body?.stream) {
        return chatCompletionStream(reply);
      }
      return jsonResponse(chatCompletionResponse(reply));
    }

    // A JSON error response, not a thrown error: the OpenAI SDK retries a
    // failed fetch with backoff and wraps it in an opaque APIConnectionError,
    // which would turn "this harness doesn't handle that path yet" into a
    // slow, confusing test failure instead of a fast, clear one.
    return new Response(
      JSON.stringify({ error: { message: `installFakeOpenAI: unhandled OpenAI request ${path}` } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

export interface IntegrationDirs {
  knowledgeDir: string;
  promptsDir: string;
  cleanup(): void;
}

/**
 * Creates a temp knowledge/prompts tree (base.txt/public.txt/private.txt are
 * required by PromptLoader) and returns a cleanup function.
 */
export function setupIntegrationDirs(prefix: string): IntegrationDirs {
  const testDir = mkdtempSync(join(tmpdir(), `chatter-${prefix}-`));
  const knowledgeDir = join(testDir, "knowledge");
  const promptsDir = join(testDir, "prompts");

  mkdirSync(join(knowledgeDir, "base"), { recursive: true });
  mkdirSync(join(knowledgeDir, "public"), { recursive: true });
  mkdirSync(promptsDir, { recursive: true });

  writeFileSync(
    join(knowledgeDir, "base", "company.md"),
    "# Test Company\nWe are a test company that makes widgets.\nOur support hours are 9 AM to 5 PM EST.",
  );
  writeFileSync(
    join(knowledgeDir, "public", "pricing.md"),
    "# Pricing\nOur basic plan is $10/month.\nPro plan is $50/month.",
  );
  writeFileSync(join(promptsDir, "base.txt"), "You are {{botName}}, a helpful assistant.");
  writeFileSync(join(promptsDir, "public.txt"), "Be friendly and concise.");
  writeFileSync(join(promptsDir, "private.txt"), "Internal mode.");

  return {
    knowledgeDir,
    promptsDir,
    cleanup: () => rmSync(testDir, { recursive: true, force: true }),
  };
}

/** Base config shared by the integration suite: in-memory db, no real API key needed. */
export function integrationConfig(
  dirs: Pick<IntegrationDirs, "knowledgeDir" | "promptsDir">,
  overrides: Partial<ChatterConfig> = {},
): ChatterConfig {
  return {
    bot: {
      name: "TestBot",
      personName: "Test Company",
      publicUrl: "http://localhost:8181",
      description: "Integration test bot",
    },
    knowledgeDir: dirs.knowledgeDir,
    promptsDir: dirs.promptsDir,
    openai: { apiKey: "sk-test-not-real" },
    // In-memory libsql: no Turso credentials, no network.
    database: { url: "file::memory:", authToken: "" },
    server: { cors: true },
    ...overrides,
  };
}
