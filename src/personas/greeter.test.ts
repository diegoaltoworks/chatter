import { describe, expect, test } from "bun:test";
import { createGreeter } from "./greeter";
import { createPersonaResolver, type PersonaRegistry } from "./resolver";

const registry: PersonaRegistry = {
  defaultPersona: "default",
  personaProbability: 1,
  contacts: {
    alice: { name: "alice", persona: "alt" },
    bob: { persona: "alt" }, // no name -> never greeted
  },
  personas: {
    default: { name: "Default", prompt: "unused" },
    alt: { name: "Alt", prompt: "unused" },
  },
};

describe("createGreeter", () => {
  test("greets a known contact by capitalized name, using its rolled persona's pool", () => {
    const resolver = createPersonaResolver({ registry, random: () => 0 }); // always wins the roll -> "alt"
    const greeter = createGreeter({
      resolver,
      templates: { alt: ["Hey {name}, welcome back."] },
      random: () => 0,
    });
    expect(greeter.greet("alice")).toBe("Hey Alice, welcome back.");
  });

  test("falls back to the default persona's pool when the roll loses", () => {
    const resolver = createPersonaResolver({ registry: { ...registry, personaProbability: 0 } });
    const greeter = createGreeter({
      resolver,
      templates: { default: ["Hi {name}."], alt: ["Yo {name}."] },
    });
    expect(greeter.greet("alice")).toBe("Hi Alice.");
  });

  test("returns null for an unknown contact", () => {
    const resolver = createPersonaResolver({ registry });
    const greeter = createGreeter({ resolver, templates: { alt: ["Hey {name}."] } });
    expect(greeter.greet("stranger")).toBeNull();
  });

  test("returns null for a contact with no name", () => {
    const resolver = createPersonaResolver({ registry, random: () => 0 });
    const greeter = createGreeter({ resolver, templates: { alt: ["Hey {name}."] } });
    expect(greeter.greet("bob")).toBeNull();
  });

  test("returns null when no template pool exists for the resolved persona", () => {
    const resolver = createPersonaResolver({ registry, random: () => 0 });
    const greeter = createGreeter({ resolver, templates: { default: ["Hi {name}."] } });
    expect(greeter.greet("alice")).toBeNull();
  });

  test("ships no built-in content — an empty templates map greets nobody", () => {
    const resolver = createPersonaResolver({ registry, random: () => 0 });
    const greeter = createGreeter({ resolver, templates: {} });
    expect(greeter.greet("alice")).toBeNull();
  });

  test("resolver failures degrade to null, never throw", () => {
    const resolver = createPersonaResolver({ registryPath: "/nonexistent/personas.json" });
    const greeter = createGreeter({ resolver, templates: { default: ["Hi {name}."] } });
    expect(greeter.greet("alice")).toBeNull();
  });
});
