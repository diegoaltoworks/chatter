import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BotIdentity } from "../types";
import { PromptLoader } from "./prompts";

describe("PromptLoader", () => {
  const testDir = join(import.meta.dir, ".test-prompts");
  const bot: BotIdentity = {
    name: "TestBot",
    personName: "John Doe",
    publicUrl: "https://testbot.example.com",
    description: "A test bot",
  };

  beforeAll(() => {
    // Create test prompts directory
    mkdirSync(testDir, { recursive: true });

    // Create test prompt files
    writeFileSync(
      join(testDir, "base.txt"),
      "You are {{botName}}, an AI assistant for {{personName}}.",
    );

    writeFileSync(
      join(testDir, "public.txt"),
      "Be friendly and helpful. You represent {{personName}} ({{personFirstName}}).",
    );

    writeFileSync(
      join(testDir, "private.txt"),
      "You are {{botName}} for internal use by {{personName}} team. Call them {{personFirstName}}.",
    );
  });

  afterAll(() => {
    // Clean up test directory
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("constructor", () => {
    it("should create a PromptLoader instance", () => {
      const loader = new PromptLoader(testDir, bot);
      expect(loader).toBeDefined();
    });
  });

  describe("baseSystemRules", () => {
    it("should load and interpolate base prompt", () => {
      const loader = new PromptLoader(testDir, bot);
      const prompt = loader.baseSystemRules;

      expect(prompt).toContain("TestBot");
      expect(prompt).toContain("John Doe");
      expect(prompt).not.toContain("{{botName}}");
      expect(prompt).not.toContain("{{personName}}");
    });

    it("should replace all occurrences of variables", () => {
      // Create a prompt with multiple uses of the same variable
      writeFileSync(
        join(testDir, "base.txt"),
        "{{botName}} is great. Talk to {{botName}}. {{botName}} helps you.",
      );

      const loader = new PromptLoader(testDir, bot);
      const prompt = loader.baseSystemRules;

      const matches = prompt.match(/TestBot/g);
      expect(matches).toHaveLength(3);
      expect(prompt).not.toContain("{{botName}}");
    });
  });

  describe("publicPersona", () => {
    it("should load and interpolate public prompt", () => {
      const loader = new PromptLoader(testDir, bot);
      const prompt = loader.publicPersona;

      expect(prompt).toContain("John Doe");
      expect(prompt).toContain("John"); // personFirstName
      expect(prompt).not.toContain("{{personName}}");
      expect(prompt).not.toContain("{{personFirstName}}");
    });

    it("should extract first name correctly", () => {
      const loader = new PromptLoader(testDir, bot);
      const prompt = loader.publicPersona;

      expect(prompt).toContain("John");
      // Should have both full name and first name
      expect(prompt).toContain("John Doe");
    });
  });

  describe("privatePersona", () => {
    it("should load and interpolate private prompt", () => {
      const loader = new PromptLoader(testDir, bot);
      const prompt = loader.privatePersona;

      expect(prompt).toContain("TestBot");
      expect(prompt).toContain("John Doe");
      expect(prompt).toContain("John");
      expect(prompt).not.toContain("{{botName}}");
      expect(prompt).not.toContain("{{personName}}");
      expect(prompt).not.toContain("{{personFirstName}}");
    });
  });

  describe("Variable interpolation", () => {
    it("should handle bot name with special characters", () => {
      // Restore original base.txt first
      writeFileSync(
        join(testDir, "base.txt"),
        "You are {{botName}}, an AI assistant for {{personName}}.",
      );

      const specialBot: BotIdentity = {
        name: "Bot-2000",
        personName: "ACME Corp",
        publicUrl: "https://bot.example.com",
        description: "Test",
      };

      const loader = new PromptLoader(testDir, specialBot);
      const prompt = loader.baseSystemRules;

      expect(prompt).toContain("Bot-2000");
      expect(prompt).toContain("ACME Corp");
    });

    it("should handle person name with multiple words", () => {
      const multiWordBot: BotIdentity = {
        name: "TestBot",
        personName: "John Michael Smith Jr",
        publicUrl: "https://test.example.com",
        description: "Test",
      };

      const loader = new PromptLoader(testDir, multiWordBot);
      const prompt = loader.publicPersona;

      expect(prompt).toContain("John Michael Smith Jr");
      expect(prompt).toContain("John"); // First name only
    });

    it("should handle single-word person name", () => {
      const singleNameBot: BotIdentity = {
        name: "TestBot",
        personName: "Madonna",
        publicUrl: "https://test.example.com",
        description: "Test",
      };

      const loader = new PromptLoader(testDir, singleNameBot);
      const prompt = loader.publicPersona;

      expect(prompt).toContain("Madonna");
      // personFirstName should also be "Madonna"
      const matches = prompt.match(/Madonna/g);
      expect(matches?.length).toBeGreaterThan(0);
    });

    it("should interpolate all variables in all prompts", () => {
      const loader = new PromptLoader(testDir, bot);

      const prompts = [loader.baseSystemRules, loader.publicPersona, loader.privatePersona];

      for (const prompt of prompts) {
        expect(prompt).not.toContain("{{");
        expect(prompt).not.toContain("}}");
      }
    });
  });

  describe("Multiple instances", () => {
    it("should allow different bots to use same prompts", () => {
      // Restore original base.txt first
      writeFileSync(
        join(testDir, "base.txt"),
        "You are {{botName}}, an AI assistant for {{personName}}.",
      );

      const bot1: BotIdentity = {
        name: "Bot1",
        personName: "Alice Smith",
        publicUrl: "https://bot1.example.com",
        description: "Bot 1",
      };

      const bot2: BotIdentity = {
        name: "Bot2",
        personName: "Bob Jones",
        publicUrl: "https://bot2.example.com",
        description: "Bot 2",
      };

      const loader1 = new PromptLoader(testDir, bot1);
      const loader2 = new PromptLoader(testDir, bot2);

      const prompt1 = loader1.baseSystemRules;
      const prompt2 = loader2.baseSystemRules;

      expect(prompt1).toContain("Bot1");
      expect(prompt1).toContain("Alice Smith");

      expect(prompt2).toContain("Bot2");
      expect(prompt2).toContain("Bob Jones");

      // Should not contain each other's values
      expect(prompt1).not.toContain("Bot2");
      expect(prompt2).not.toContain("Bot1");
    });
  });

  describe("Edge cases", () => {
    it("should handle empty person name gracefully", () => {
      const emptyBot: BotIdentity = {
        name: "TestBot",
        personName: "",
        publicUrl: "https://test.example.com",
        description: "Test",
      };

      const loader = new PromptLoader(testDir, emptyBot);
      const prompt = loader.publicPersona;

      // Should not crash, personFirstName will be empty
      expect(prompt).toBeDefined();
    });

    it("should handle prompts without template variables", () => {
      writeFileSync(join(testDir, "base.txt"), "This is a static prompt.");

      const loader = new PromptLoader(testDir, bot);
      const prompt = loader.baseSystemRules;

      expect(prompt).toBe("This is a static prompt.");
    });

    it("should handle prompts with partial template syntax", () => {
      writeFileSync(join(testDir, "base.txt"), "Welcome to {{botName}} (cost is ${{price}}).");

      const loader = new PromptLoader(testDir, bot);
      const prompt = loader.baseSystemRules;

      // Should replace {{botName}} but leave ${{price}} alone
      expect(prompt).toContain("TestBot");
      expect(prompt).toContain("${{price}}");
    });
  });
});
