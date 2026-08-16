import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { completionCallViolations } from "./architecture-invariants";

describe("completionCallViolations", () => {
  test("a call in the one sanctioned caller is not a violation", () => {
    expect(completionCallViolations("core/answer.ts", "  return completeOnce(args);")).toEqual([]);
  });

  test("a call outside core/answer.ts is a violation, naming the function and line", () => {
    const [violation] = completionCallViolations(
      "routes/chat.ts",
      "async function go() {\n  return completeOnce(args);\n}",
    );

    expect(violation?.file).toBe("routes/chat.ts");
    expect(violation?.line).toBe(2);
    expect(violation?.reason).toContain("completeOnce");
  });

  test("completeStream is checked the same way", () => {
    expect(completionCallViolations("routes/chat.ts", "yield* completeStream(args);")).toHaveLength(
      1,
    );
  });

  test("a bare import or re-export is not a call site", () => {
    expect(
      completionCallViolations(
        "index.ts",
        'export { completeOnce, completeStream } from "./core/llm";',
      ),
    ).toEqual([]);
  });

  test("a mention inside a comment is not a call site", () => {
    const contents = [
      "// calls completeOnce(args) internally",
      "/** honours completeStream(args) as a fallback */",
      " * see completeOnce(args) above",
    ].join("\n");

    expect(completionCallViolations("routes/chat.ts", contents)).toEqual([]);
  });

  test("core/llm.ts, where the functions are defined, is exempt", () => {
    expect(
      completionCallViolations("core/llm.ts", "export async function completeOnce() {}"),
    ).toEqual([]);
  });

  test("reports every violation in a file, not just the first", () => {
    const contents = "completeOnce(a);\ncompleteStream(b);";
    expect(completionCallViolations("routes/chat.ts", contents)).toHaveLength(2);
  });

  test("reports both calls when they share a line", () => {
    expect(
      completionCallViolations("routes/chat.ts", "completeOnce(a); completeStream(b);"),
    ).toHaveLength(2);
  });

  test("a mention after a trailing // comment is not a call site", () => {
    expect(
      completionCallViolations("routes/chat.ts", "doStuff(); // never call completeOnce(x) here"),
    ).toEqual([]);
  });

  test("a call reached through a renamed import is still caught", () => {
    const contents = [
      'import { completeOnce as callLLM } from "../core/llm";',
      "callLLM(args);",
    ].join("\n");

    const [violation] = completionCallViolations("routes/chat.ts", contents);
    expect(violation?.line).toBe(2);
    expect(violation?.reason).toContain("completeOnce");
    expect(violation?.reason).toContain("callLLM");
  });

  test("the renamed import line itself is not a call site", () => {
    const contents = 'import { completeStream as run } from "../core/llm";';
    expect(completionCallViolations("routes/chat.ts", contents)).toEqual([]);
  });

  test("a comment merely mentioning an alias-like rename does not register an alias", () => {
    const contents = ["// never write `completeOnce as run` here", "server.run(1);"].join("\n");
    expect(completionCallViolations("routes/chat.ts", contents)).toEqual([]);
  });

  test("a member call on an unrelated object sharing an alias's name is not a violation", () => {
    const contents = ['import { completeOnce as run } from "../core/llm";', "server.run(1);"].join(
      "\n",
    );
    expect(completionCallViolations("routes/chat.ts", contents)).toEqual([]);
  });

  test("a multi-line import block still yields its alias", () => {
    const contents = [
      "import {",
      "  completeOnce as run,",
      '} from "../core/llm";',
      "run(args);",
    ].join("\n");

    const [violation] = completionCallViolations("routes/chat.ts", contents);
    expect(violation?.line).toBe(4);
  });

  test("a // inside a string literal does not swallow real code later on the line", () => {
    const contents = 'const url = "https://example.com"; completeOnce(args);';
    expect(completionCallViolations("routes/chat.ts", contents)).toHaveLength(1);
  });

  test("a genuine trailing comment after a string literal is still ignored", () => {
    const contents = 'const url = "https://example.com"; // completeOnce(args) mentioned here only';
    expect(completionCallViolations("routes/chat.ts", contents)).toEqual([]);
  });
});

/** Build artefacts and dependency trees this repo's own code never wrote. */
function isGenerated(path: string): boolean {
  return path.includes("node_modules/") || path.includes("/dist/") || path.startsWith("dist/");
}

/** Every non-test `.ts` file under `dir`, relative to `dir`, skipping generated trees. */
function tsFilesUnder(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !isGenerated(name),
  );
}

// The point of the helper above: nothing in this repo's actual src/ or bin/
// tree calls completeOnce/completeStream outside core/answer.ts. A new
// surface that bypasses the answerFn hook fails here instead of just going
// unnoticed until a consumer's answerFn silently stops being honoured.
describe("this repo's brain-hook call sites", () => {
  const root = join(import.meta.dir, "..");
  const srcDir = join(root, "src");
  const binDir = join(root, "bin");

  const files = [
    ...tsFilesUnder(srcDir).map((file) => ({ onDisk: join(srcDir, file), tag: file })),
    ...tsFilesUnder(binDir).map((file) => ({ onDisk: join(binDir, file), tag: `../bin/${file}` })),
  ];

  test("there are source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("only core/answer.ts calls completeOnce/completeStream directly", () => {
    const violations = files.flatMap(({ onDisk, tag }) =>
      completionCallViolations(tag, readFileSync(onDisk, "utf8")),
    );

    expect(violations).toEqual([]);
  });
});
