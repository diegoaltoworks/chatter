import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersonaResolver, type PersonaRegistry } from "./resolver";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "personas-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePrompt(name: string, content: string): string {
  writeFileSync(join(dir, name), content, "utf-8");
  return name;
}

const baseRegistry = (): PersonaRegistry => ({
  defaultPersona: "default",
  personaProbability: 1,
  personaWindowMinutes: 10,
  contacts: {
    alice: { name: "Alice", persona: "alt" },
  },
  personas: {
    default: {
      name: "Default",
      prompt: writePrompt("default.txt", "You are the default assistant."),
    },
    alt: { name: "Alt", prompt: writePrompt("alt.txt", "You are {{botName}}, speaking as Alt.") },
  },
});

describe("createPersonaResolver", () => {
  test("unmapped contact rolls null (default)", () => {
    const resolver = createPersonaResolver({ registry: baseRegistry(), promptsDir: dir });
    expect(resolver.rollPersonaId("stranger")).toBeNull();
  });

  test("mapped contact rolls its persona at 100% probability", () => {
    const resolver = createPersonaResolver({
      registry: baseRegistry(),
      promptsDir: dir,
      random: () => 0,
    });
    expect(resolver.rollPersonaId("alice")).toBe("alt");
  });

  test("roll is held for the configured window, then re-rolled", () => {
    let time = 0;
    const registry = baseRegistry();
    registry.personaWindowMinutes = 5;
    let rollCount = 0;
    const resolver = createPersonaResolver({
      registry,
      promptsDir: dir,
      now: () => time,
      random: () => {
        rollCount += 1;
        return 0; // always wins the roll
      },
    });

    expect(resolver.rollPersonaId("alice")).toBe("alt");
    time += 4 * 60 * 1000; // within the 5-minute window
    expect(resolver.rollPersonaId("alice")).toBe("alt");
    expect(rollCount).toBe(1); // second call was served from the held window, no re-roll

    time += 2 * 60 * 1000; // past the window
    expect(resolver.rollPersonaId("alice")).toBe("alt");
    expect(rollCount).toBe(2);
  });

  test("per-contact probability overrides the registry default", () => {
    const registry = baseRegistry();
    registry.personaProbability = 0; // global: never roll
    registry.contacts = { alice: { name: "Alice", persona: "alt", probability: 1 } }; // contact: always roll

    const resolver = createPersonaResolver({ registry, promptsDir: dir, random: () => 0.9 });
    expect(resolver.rollPersonaId("alice")).toBe("alt");
  });

  test("losing the roll holds null for the window, then re-rolls", () => {
    let time = 0;
    const registry = baseRegistry();
    registry.personaProbability = 0;
    registry.personaWindowMinutes = 5;
    let rollCount = 0;
    const resolver = createPersonaResolver({
      registry,
      promptsDir: dir,
      now: () => time,
      random: () => {
        rollCount += 1;
        return 0.99; // always loses the roll
      },
    });

    expect(resolver.rollPersonaId("alice")).toBeNull();
    time += 4 * 60 * 1000; // within the 5-minute window
    expect(resolver.rollPersonaId("alice")).toBeNull();
    expect(rollCount).toBe(1); // held, no re-roll

    time += 2 * 60 * 1000; // past the window
    expect(resolver.rollPersonaId("alice")).toBeNull();
    expect(rollCount).toBe(2);
  });

  test("re-rolls exactly at window expiry — the hold is exclusive of the boundary", () => {
    let time = 0;
    const registry = baseRegistry();
    registry.personaWindowMinutes = 5;
    let rollCount = 0;
    const resolver = createPersonaResolver({
      registry,
      promptsDir: dir,
      now: () => time,
      random: () => {
        rollCount += 1;
        return 0;
      },
    });

    resolver.rollPersonaId("alice");
    time = 5 * 60 * 1000; // exactly expiresAt
    resolver.rollPersonaId("alice");
    expect(rollCount).toBe(2);
  });

  test("personaLayerFor loads and interpolates the prompt file, then caches it", () => {
    const resolver = createPersonaResolver({
      registry: baseRegistry(),
      promptsDir: dir,
      vars: { botName: "Chatter" },
    });
    expect(resolver.personaLayerFor("alt")).toBe("You are Chatter, speaking as Alt.");
    // second call is served from cache; mutate the file to prove it isn't re-read
    writeFileSync(join(dir, "alt.txt"), "changed", "utf-8");
    expect(resolver.personaLayerFor("alt")).toBe("You are Chatter, speaking as Alt.");
  });

  test("personaLayerFor(null) returns null without touching the registry", () => {
    const resolver = createPersonaResolver({ registryPath: join(dir, "missing.json") });
    expect(resolver.personaLayerFor(null)).toBeNull();
  });

  test("resolvePersonaLayer falls back to the default persona layer when the roll loses", () => {
    const registry = baseRegistry();
    registry.personaProbability = 0;
    const resolver = createPersonaResolver({ registry, promptsDir: dir });
    expect(resolver.resolvePersonaLayer("alice")).toBe("You are the default assistant.");
  });

  test("resolvePersonaLayer uses the rolled persona layer when it wins", () => {
    const resolver = createPersonaResolver({
      registry: baseRegistry(),
      promptsDir: dir,
      vars: { botName: "Chatter" },
      random: () => 0,
    });
    expect(resolver.resolvePersonaLayer("alice")).toBe("You are Chatter, speaking as Alt.");
  });

  test("unknown persona id degrades to null, never throws", () => {
    const resolver = createPersonaResolver({ registry: baseRegistry(), promptsDir: dir });
    expect(resolver.personaLayerFor("nonexistent")).toBeNull();
  });

  test("missing registry file degrades to null, never throws", () => {
    const resolver = createPersonaResolver({ registryPath: join(dir, "missing.json") });
    expect(resolver.rollPersonaId("alice")).toBeNull();
    expect(resolver.contactFor("alice")).toBeUndefined();
    expect(resolver.defaultPersonaId()).toBeNull();
    expect(resolver.resolvePersonaLayer("alice")).toBeNull();
  });

  test("malformed registry JSON degrades to null, never throws", () => {
    writeFileSync(join(dir, "bad.json"), "{ not json", "utf-8");
    const resolver = createPersonaResolver({ registryPath: join(dir, "bad.json") });
    expect(resolver.rollPersonaId("alice")).toBeNull();
  });

  test("missing prompt file degrades to null, never throws", () => {
    const registry = baseRegistry();
    registry.personas.alt = { name: "Alt", prompt: "does-not-exist.txt" };
    const resolver = createPersonaResolver({ registry, promptsDir: dir });
    expect(resolver.personaLayerFor("alt")).toBeNull();
  });

  test("a registry load failure is memoized — a later fix to the file is not picked up", () => {
    const registryPath = join(dir, "bad2.json");
    writeFileSync(registryPath, "{ not json", "utf-8");
    const resolver = createPersonaResolver({ registryPath });
    expect(resolver.rollPersonaId("alice")).toBeNull();

    writeFileSync(registryPath, JSON.stringify(baseRegistry()), "utf-8");
    expect(resolver.rollPersonaId("alice")).toBeNull(); // still null: not re-read on a live resolver
  });

  test("a prompt load failure is memoized — a later fix to the file is not picked up", () => {
    const registry = baseRegistry();
    registry.personas.alt = { name: "Alt", prompt: "missing-then-created.txt" };
    const resolver = createPersonaResolver({ registry, promptsDir: dir });
    expect(resolver.personaLayerFor("alt")).toBeNull();

    writeFileSync(join(dir, "missing-then-created.txt"), "now it exists", "utf-8");
    expect(resolver.personaLayerFor("alt")).toBeNull(); // still null: not re-read on a live resolver
  });

  test("throws at construction when neither registry nor registryPath is given", () => {
    expect(() => createPersonaResolver()).toThrow("requires a registry or registryPath");
    expect(() => createPersonaResolver({})).toThrow("requires a registry or registryPath");
  });

  test("contactFor returns the registry contact record", () => {
    const resolver = createPersonaResolver({ registry: baseRegistry(), promptsDir: dir });
    expect(resolver.contactFor("alice")).toEqual({ name: "Alice", persona: "alt" });
    expect(resolver.contactFor("stranger")).toBeUndefined();
  });

  test("defaultPersonaId reads the registry's configured default", () => {
    const resolver = createPersonaResolver({ registry: baseRegistry(), promptsDir: dir });
    expect(resolver.defaultPersonaId()).toBe("default");
  });

  test("loads a registry from disk via registryPath, prompts relative to its directory", () => {
    const registry = baseRegistry();
    const registryPath = join(dir, "personas.json");
    writeFileSync(registryPath, JSON.stringify(registry), "utf-8");
    const resolver = createPersonaResolver({ registryPath });
    expect(resolver.personaLayerFor("default")).toBe("You are the default assistant.");
  });
});
