/**
 * Flow engine tests — the full processFlow-equivalent lifecycle: triggering,
 * multi-turn param collection, completion, cancellation and error handling.
 * Uses a faked OpenAI client (never a real API call) and an in-memory
 * FlowSessionStore standing in for the Turso-backed one, which has its own
 * dedicated tests in session.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import type OpenAI from "openai";
import { createFlowEngine } from "./engine";
import { createTursoFlowSessionStore } from "./session";
import type { FlowSessionState, FlowSessionStore } from "./types";

function inMemorySessionStore(): FlowSessionStore {
  const sessions = new Map<string, FlowSessionState>();
  return {
    async get(key) {
      return sessions.get(key) ?? null;
    },
    async set(key, state) {
      sessions.set(key, state);
    },
    async clear(key) {
      sessions.delete(key);
    },
  };
}

/** Queues canned chat-completion responses, one per call, in order. */
function queuedClient(responses: string[]): OpenAI {
  let index = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          const content = responses[Math.min(index, responses.length - 1)];
          index += 1;
          return { choices: [{ message: { content } }] };
        },
      },
    },
  } as unknown as OpenAI;
}

const FIXTURES_DIR = `${import.meta.dir}/__fixtures__`;

describe("createFlowEngine", () => {
  test("triggers a flow via LLM intent detection and completes it in one turn when params are already filled", async () => {
    const client = queuedClient([
      JSON.stringify({ intent: "greeting", confidence: 0.95 }),
      JSON.stringify({ extractedParams: { name: "Ada" } }),
    ]);
    const engine = createFlowEngine({
      client,
      model: "gpt-4o-mini",
      flowsDir: FIXTURES_DIR,
      sessionStore: inMemorySessionStore(),
    });
    await engine.loadFlows();

    const result = await engine.process("session-1", "hi, I'm Ada");

    expect(result).toEqual({
      isFlowActive: false,
      message: "Hello, Ada!",
      flowCompleted: true,
      flowSuccess: true,
      result: { name: "Ada" },
    });
  });

  test("first turn without a full param set persists session state and stays active", async () => {
    const client = queuedClient([
      JSON.stringify({ intent: "greeting", confidence: 0.95 }),
      JSON.stringify({ extractedParams: {} }),
    ]);
    const sessionStore = inMemorySessionStore();
    const engine = createFlowEngine({
      client,
      model: "gpt-4o-mini",
      flowsDir: FIXTURES_DIR,
      sessionStore,
    });
    await engine.loadFlows();

    const firstTurn = await engine.process("session-2", "hi");

    expect(firstTurn.isFlowActive).toBe(true);
    expect(firstTurn.flowCompleted).toBe(false);
    expect(await sessionStore.get("session-2")).toEqual({
      flowId: "greeting",
      params: {},
      attempts: 1,
      startedAt: expect.any(Number),
    });
  });

  test("multi-turn flow completes once the second turn fills every required field", async () => {
    const client = queuedClient([
      JSON.stringify({ intent: "greeting", confidence: 0.95 }),
      JSON.stringify({ extractedParams: {} }),
      JSON.stringify({ extractedParams: { name: "Ada" } }),
    ]);
    const sessionStore = inMemorySessionStore();
    const engine = createFlowEngine({
      client,
      model: "gpt-4o-mini",
      flowsDir: FIXTURES_DIR,
      sessionStore,
    });
    await engine.loadFlows();

    const firstTurn = await engine.process("session-3", "hi");
    expect(firstTurn.isFlowActive).toBe(true);

    const secondTurn = await engine.process("session-3", "Ada");
    expect(secondTurn).toEqual({
      isFlowActive: false,
      message: "Hello, Ada!",
      flowCompleted: true,
      flowSuccess: true,
      result: { name: "Ada" },
    });
    expect(await sessionStore.get("session-3")).toBeNull();
  });

  test("a critical keyword triggers its mapped flow without an LLM call", async () => {
    let callCount = 0;
    const client = {
      chat: {
        completions: {
          create: async () => {
            callCount += 1;
            return {
              choices: [
                { message: { content: JSON.stringify({ extractedParams: { name: "Ada" } }) } },
              ],
            };
          },
        },
      },
    } as unknown as OpenAI;
    const engine = createFlowEngine({
      client,
      model: "gpt-4o-mini",
      flowsDir: FIXTURES_DIR,
      sessionStore: inMemorySessionStore(),
      criticalKeywords: { hello: "greeting" },
    });
    await engine.loadFlows();

    const result = await engine.process("session-4", "hello there, I'm Ada");

    expect(result.flowCompleted).toBe(true);
    // One call: parameter extraction only. Intent-detection is skipped
    // because the keyword step already resolved the flow.
    expect(callCount).toBe(1);
  });

  test("cancelling an active flow clears its session and returns cancelled: true", async () => {
    const client = queuedClient([
      JSON.stringify({ intent: "greeting", confidence: 0.95 }),
      JSON.stringify({ extractedParams: {} }),
    ]);
    const sessionStore = inMemorySessionStore();
    const engine = createFlowEngine({
      client,
      model: "gpt-4o-mini",
      flowsDir: FIXTURES_DIR,
      sessionStore,
    });
    await engine.loadFlows();

    await engine.process("session-5", "hi");
    expect(await sessionStore.get("session-5")).not.toBeNull();

    const result = await engine.process("session-5", "actually, cancel");

    expect(result).toEqual({
      isFlowActive: false,
      message: "Okay, cancelled.",
      flowCompleted: false,
      cancelled: true,
    });
    expect(await sessionStore.get("session-5")).toBeNull();
  });

  test("returns an error result and clears the session when the active flow was removed from the registry", async () => {
    const sessionStore = inMemorySessionStore();
    await sessionStore.set("session-6", {
      flowId: "goneMissing",
      params: {},
      attempts: 1,
      startedAt: 1,
    });
    const engine = createFlowEngine({
      client: queuedClient([]),
      model: "gpt-4o-mini",
      flowsDir: FIXTURES_DIR,
      sessionStore,
    });
    await engine.loadFlows();

    const result = await engine.process("session-6", "hello");

    expect(result).toEqual({
      isFlowActive: false,
      message: "Sorry, something went wrong. Please try again.",
      flowCompleted: false,
      error: true,
    });
    expect(await sessionStore.get("session-6")).toBeNull();
  });

  test("returns an error but keeps the session when extraction fails mid-flow, so a retry doesn't lose collected params", async () => {
    const sessionStore = inMemorySessionStore();
    const existingState = { flowId: "greeting", params: {}, attempts: 1, startedAt: 1 };
    await sessionStore.set("session-7", existingState);
    const client = {
      chat: {
        completions: {
          create: async () => {
            throw new Error("upstream failure");
          },
        },
      },
    } as unknown as OpenAI;
    const engine = createFlowEngine({
      client,
      model: "gpt-4o-mini",
      flowsDir: FIXTURES_DIR,
      sessionStore,
    });
    await engine.loadFlows();

    const result = await engine.process("session-7", "Ada");

    expect(result).toEqual({
      isFlowActive: true,
      message: "Sorry, something went wrong. Please try again.",
      flowCompleted: false,
      error: true,
    });
    expect(await sessionStore.get("session-7")).toEqual(existingState);
  });

  test("no flow triggers and no session is created when nothing matches", async () => {
    const client = queuedClient([JSON.stringify({ intent: "chatbot", confidence: 0.2 })]);
    const sessionStore = inMemorySessionStore();
    const engine = createFlowEngine({
      client,
      model: "gpt-4o-mini",
      flowsDir: FIXTURES_DIR,
      sessionStore,
    });
    await engine.loadFlows();

    const result = await engine.process("session-8", "what's the weather");

    expect(result).toEqual({ isFlowActive: false, message: "", flowCompleted: false });
    expect(await sessionStore.get("session-8")).toBeNull();
  });

  test("works end to end against the real Turso-backed session store", async () => {
    const client = queuedClient([
      JSON.stringify({ intent: "greeting", confidence: 0.95 }),
      JSON.stringify({ extractedParams: { name: "Ada" } }),
    ]);
    const engine = createFlowEngine({
      client,
      model: "gpt-4o-mini",
      flowsDir: FIXTURES_DIR,
      sessionStore: createTursoFlowSessionStore(createClient({ url: ":memory:" })),
    });
    await engine.loadFlows();

    const result = await engine.process("session-9", "hi, I'm Ada");

    expect(result.flowCompleted).toBe(true);
    expect(result.message).toBe("Hello, Ada!");
  });

  test("multi-turn param collection and cancellation both round-trip through the real Turso-backed session store", async () => {
    const client = queuedClient([
      JSON.stringify({ intent: "greeting", confidence: 0.95 }),
      JSON.stringify({ extractedParams: {} }),
    ]);
    const sessionStore = createTursoFlowSessionStore(createClient({ url: ":memory:" }));
    const engine = createFlowEngine({
      client,
      model: "gpt-4o-mini",
      flowsDir: FIXTURES_DIR,
      sessionStore,
    });
    await engine.loadFlows();

    const firstTurn = await engine.process("session-10", "hi");
    expect(firstTurn.isFlowActive).toBe(true);
    expect(await sessionStore.get("session-10")).toEqual({
      flowId: "greeting",
      params: {},
      attempts: 1,
      startedAt: expect.any(Number),
    });

    const cancelled = await engine.process("session-10", "actually, cancel");
    expect(cancelled.cancelled).toBe(true);
    expect(await sessionStore.get("session-10")).toBeNull();
  });

  test("a throwing prefill is caught, not left to reject process()", async () => {
    const client = queuedClient([JSON.stringify({ intent: "greeting", confidence: 0.95 })]);
    const engine = createFlowEngine({
      client,
      model: "gpt-4o-mini",
      flowsDir: FIXTURES_DIR,
      sessionStore: inMemorySessionStore(),
    });
    await engine.loadFlows();
    // Overwrite the fixture's benign prefill with one that throws.
    const flow = engine.getFlow("greeting");
    // biome-ignore lint/style/noNonNullAssertion: fixture guarantees this flow loaded
    flow!.prefill = () => {
      throw new Error("prefill boom");
    };

    const result = await engine.process("session-11", "hi");

    expect(result).toEqual({
      isFlowActive: false,
      message: "Sorry, something went wrong. Please try again.",
      flowCompleted: false,
      error: true,
    });
  });

  test("passes prefillContext through to a freshly-triggered flow's prefill", async () => {
    const client = queuedClient([
      JSON.stringify({ intent: "greeting", confidence: 0.95 }),
      JSON.stringify({ extractedParams: {} }),
    ]);
    const engine = createFlowEngine({
      client,
      model: "gpt-4o-mini",
      flowsDir: FIXTURES_DIR,
      sessionStore: inMemorySessionStore(),
    });
    await engine.loadFlows();

    // The fixture's prefillFromContext returns its context verbatim, so a
    // pre-known name completes the flow without ever being "extracted".
    const result = await engine.process("session-12", "hi", {
      prefillContext: { name: "Ada" },
    });

    expect(result.flowCompleted).toBe(true);
    expect(result.message).toBe("Hello, Ada!");
  });

  test("an expired session is dropped and the message is matched fresh instead of continuing it", async () => {
    const client = queuedClient([
      // No "greeting" intent-detection call here: the message doesn't
      // mention "hi"/"hello", so nothing matches once the stale session for
      // "date" is dropped.
      JSON.stringify({ intent: "chatbot", confidence: 0.1 }),
    ]);
    const sessionStore = inMemorySessionStore();
    await sessionStore.set("session-13", {
      flowId: "greeting",
      params: {},
      attempts: 1,
      startedAt: 0,
    });
    const engine = createFlowEngine({
      client,
      model: "gpt-4o-mini",
      flowsDir: FIXTURES_DIR,
      sessionStore,
      sessionTtlMs: 1000,
      now: () => 5000,
    });
    await engine.loadFlows();

    const result = await engine.process("session-13", "what's the weather");

    expect(result).toEqual({ isFlowActive: false, message: "", flowCompleted: false });
    expect(await sessionStore.get("session-13")).toBeNull();
  });

  test("a session within its TTL is still resumed normally", async () => {
    const client = queuedClient([JSON.stringify({ extractedParams: { name: "Ada" } })]);
    const sessionStore = inMemorySessionStore();
    await sessionStore.set("session-14", {
      flowId: "greeting",
      params: {},
      attempts: 1,
      startedAt: 4500,
    });
    const engine = createFlowEngine({
      client,
      model: "gpt-4o-mini",
      flowsDir: FIXTURES_DIR,
      sessionStore,
      sessionTtlMs: 1000,
      now: () => 5000,
    });
    await engine.loadFlows();

    const result = await engine.process("session-14", "Ada");

    expect(result.flowCompleted).toBe(true);
    expect(result.message).toBe("Hello, Ada!");
  });
});
