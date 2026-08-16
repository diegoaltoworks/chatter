import type OpenAI from "openai";
import type { AnswerFn } from "../core/answer";
import { answerOnce } from "../core/answer";
import { createConsoleLogger, type Logger } from "../core/logger";
import type { PipelineMessage, PipelineMode } from "../core/pipeline";
import type { ComposeFn, ScheduleEntry } from "./types";

/**
 * Runs the pluggable compose step and guarantees a message comes back: a
 * missing compose function, a blank result, or a throwing/rejecting compose
 * all fall back to `fallbackMessage` rather than blocking delivery.
 */
export async function composeMessage(
  entry: ScheduleEntry,
  compose: ComposeFn | undefined,
  fallbackMessage: string,
  logger: Logger = createConsoleLogger(),
): Promise<string> {
  if (!compose) return fallbackMessage;
  try {
    const result = await compose(entry);
    return result.trim().length > 0 ? result : fallbackMessage;
  } catch (error) {
    logger.warn(`Scheduler compose failed for entry "${entry.id}":`, error);
    return fallbackMessage;
  }
}

export interface AnswerComposeOptions {
  client: OpenAI;
  system: string;
  /** Turns a schedule entry's opaque payload into the messages sent to the brain. */
  buildMessages: (entry: ScheduleEntry) => PipelineMessage[];
  answerFn?: AnswerFn;
  mode?: PipelineMode;
  temperature?: number;
  model?: string;
}

/** Builds a `ComposeFn` that composes via `answerFn`/`completeOnce`, for callers who want an LLM-written message instead of static text. */
export function createAnswerCompose(options: AnswerComposeOptions): ComposeFn {
  return async (entry) => {
    const { content } = await answerOnce({
      client: options.client,
      system: options.system,
      messages: options.buildMessages(entry),
      mode: options.mode ?? "private",
      answerFn: options.answerFn,
      temperature: options.temperature,
      model: options.model,
    });
    return content;
  };
}
