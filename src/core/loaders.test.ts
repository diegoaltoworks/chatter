import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadKnowledge } from "./loaders";

describe("Knowledge Loaders", () => {
  const testDir = join(import.meta.dir, ".test-loaders");
  const knowledgeDir = join(testDir, "knowledge");

  beforeAll(() => {
    // Create test knowledge directory structure
    mkdirSync(join(knowledgeDir, "base"), { recursive: true });
    mkdirSync(join(knowledgeDir, "public"), { recursive: true });
    mkdirSync(join(knowledgeDir, "private"), { recursive: true });

    // Create test markdown files
    writeFileSync(
      join(knowledgeDir, "base", "company.md"),
      "# Company Info\nWe are a test company.\nFounded in 2020.",
    );

    // Create nested directory first
    mkdirSync(join(knowledgeDir, "base", "nested"), { recursive: true });
    writeFileSync(
      join(knowledgeDir, "base", "nested", "deep.md"),
      "# Deep Content\nNested file content.",
    );

    writeFileSync(
      join(knowledgeDir, "public", "pricing.md"),
      "# Pricing\nBasic: $10/month\nPro: $50/month",
    );

    writeFileSync(
      join(knowledgeDir, "public", "faqs.md"),
      "# FAQs\n## Q: What do you offer?\nA: Great products.",
    );

    writeFileSync(
      join(knowledgeDir, "private", "runbook.md"),
      "# Internal Runbook\nStep 1: Check logs\nStep 2: Restart service",
    );

    // Create a non-markdown file (should be ignored)
    writeFileSync(join(knowledgeDir, "base", "readme.txt"), "This is not markdown");
  });

  afterAll(() => {
    // Clean up test directory
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("loadKnowledge", () => {
    it("should load all markdown files from all buckets", () => {
      const docs = loadKnowledge(knowledgeDir);

      expect(docs.length).toBeGreaterThan(0);
      // Should have files from base, public, and private
      expect(docs.some((d) => d.bucket === "base")).toBe(true);
      expect(docs.some((d) => d.bucket === "public")).toBe(true);
      expect(docs.some((d) => d.bucket === "private")).toBe(true);
    });

    it("should load base bucket files", () => {
      const docs = loadKnowledge(knowledgeDir);
      const baseDocs = docs.filter((d) => d.bucket === "base");

      expect(baseDocs.length).toBeGreaterThanOrEqual(1);
      const companyDoc = baseDocs.find((d) => d.source.includes("company.md"));
      expect(companyDoc).toBeDefined();
      expect(companyDoc?.text).toContain("test company");
    });

    it("should load public bucket files", () => {
      const docs = loadKnowledge(knowledgeDir);
      const publicDocs = docs.filter((d) => d.bucket === "public");

      expect(publicDocs.length).toBeGreaterThanOrEqual(2);
      const pricingDoc = publicDocs.find((d) => d.source.includes("pricing.md"));
      expect(pricingDoc).toBeDefined();
      expect(pricingDoc?.text).toContain("$10/month");
    });

    it("should load private bucket files", () => {
      const docs = loadKnowledge(knowledgeDir);
      const privateDocs = docs.filter((d) => d.bucket === "private");

      expect(privateDocs.length).toBeGreaterThanOrEqual(1);
      const runbookDoc = privateDocs.find((d) => d.source.includes("runbook.md"));
      expect(runbookDoc).toBeDefined();
      expect(runbookDoc?.text).toContain("Internal Runbook");
    });

    it("should include file path as source", () => {
      const docs = loadKnowledge(knowledgeDir);

      for (const doc of docs) {
        expect(doc.source).toBeDefined();
        expect(doc.source).toContain(".md");
        expect(doc.source).toMatch(/base|public|private/);
      }
    });

    it("should include file path as id", () => {
      const docs = loadKnowledge(knowledgeDir);

      for (const doc of docs) {
        expect(doc.id).toBeDefined();
        expect(doc.id).toBe(doc.source);
      }
    });

    it("should include correct bucket metadata", () => {
      const docs = loadKnowledge(knowledgeDir);

      for (const doc of docs) {
        expect(doc.bucket).toMatch(/^(base|public|private)$/);
      }
    });

    it("should load complete file content", () => {
      const docs = loadKnowledge(knowledgeDir);
      const pricingDoc = docs.find((d) => d.source.includes("pricing.md"));

      expect(pricingDoc?.text).toContain("# Pricing");
      expect(pricingDoc?.text).toContain("Basic");
      expect(pricingDoc?.text).toContain("Pro");
    });

    it("should handle nested directories", () => {
      const docs = loadKnowledge(knowledgeDir);
      const nestedDoc = docs.find((d) => d.source.includes("nested"));

      expect(nestedDoc).toBeDefined();
      expect(nestedDoc?.text).toContain("Deep Content");
    });

    it("should only load .md files", () => {
      const docs = loadKnowledge(knowledgeDir);

      // Should not include readme.txt
      const txtFile = docs.find((d) => d.source.includes("readme.txt"));
      expect(txtFile).toBeUndefined();

      // All files should end with .md
      for (const doc of docs) {
        expect(doc.source).toEndWith(".md");
      }
    });

    it("should handle missing bucket directories gracefully", () => {
      const emptyDir = join(testDir, "empty-knowledge");
      mkdirSync(emptyDir, { recursive: true });

      const docs = loadKnowledge(emptyDir);
      expect(docs).toBeArrayOfSize(0);

      rmSync(emptyDir, { recursive: true, force: true });
    });

    it("should handle custom root directory", () => {
      const customDir = join(testDir, "custom");
      mkdirSync(join(customDir, "base"), { recursive: true });
      writeFileSync(join(customDir, "base", "test.md"), "Custom content");

      const docs = loadKnowledge(customDir);
      expect(docs.length).toBe(1);
      expect(docs[0].text).toBe("Custom content");

      rmSync(customDir, { recursive: true, force: true });
    });

    it("should preserve newlines in file content", () => {
      const docs = loadKnowledge(knowledgeDir);
      const companyDoc = docs.find((d) => d.source.includes("company.md"));

      expect(companyDoc?.text).toContain("\n");
      const lines = companyDoc?.text.split("\n");
      expect(lines?.length).toBeGreaterThan(1);
    });

    it("should handle multiple files in same bucket", () => {
      const docs = loadKnowledge(knowledgeDir);
      const publicDocs = docs.filter((d) => d.bucket === "public");

      expect(publicDocs.length).toBeGreaterThanOrEqual(2);
      const sources = publicDocs.map((d) => d.source);
      expect(sources.some((s) => s.includes("pricing.md"))).toBe(true);
      expect(sources.some((s) => s.includes("faqs.md"))).toBe(true);
    });

    it("should create unique document objects", () => {
      const docs = loadKnowledge(knowledgeDir);

      // Each document should be a unique object
      const ids = new Set(docs.map((d) => d.id));
      expect(ids.size).toBe(docs.length);
    });

    it("should handle empty markdown files", () => {
      const emptyDir = join(testDir, "empty-files");
      mkdirSync(join(emptyDir, "base"), { recursive: true });
      writeFileSync(join(emptyDir, "base", "empty.md"), "");

      const docs = loadKnowledge(emptyDir);
      expect(docs.length).toBe(1);
      expect(docs[0].text).toBe("");

      rmSync(emptyDir, { recursive: true, force: true });
    });
  });
});
