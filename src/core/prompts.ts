/**
 * System Prompts Loader
 * Loads prompt templates and interpolates bot configuration
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BotIdentity } from "../types";

/**
 * Prompt loader class that loads and interpolates prompt templates
 * with bot identity information
 */
export class PromptLoader {
  constructor(
    private promptsDir: string,
    private bot: BotIdentity,
  ) {}

  /**
   * Load a prompt template and interpolate variables
   */
  private load(filename: string): string {
    const path = join(this.promptsDir, filename);
    const template = readFileSync(path, "utf-8");

    // Extract first name from full person name
    const personFirstName = this.bot.personName.split(" ")[0];

    // Replace template variables
    return template
      .replace(/\{\{botName\}\}/g, this.bot.name)
      .replace(/\{\{personName\}\}/g, this.bot.personName)
      .replace(/\{\{personFirstName\}\}/g, personFirstName);
  }

  /** Base system rules prompt */
  get baseSystemRules(): string {
    return this.load("base.txt");
  }

  /** Public persona prompt */
  get publicPersona(): string {
    return this.load("public.txt");
  }

  /** Private persona prompt */
  get privatePersona(): string {
    return this.load("private.txt");
  }
}
