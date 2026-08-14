/** Cancellation-phrase detection, kept separate because it's pure and cheap to check before any LLM call. */

const DEFAULT_CANCEL_KEYWORDS = ["cancel", "nevermind", "never mind", "stop", "forget it", "quit"];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word/phrase match so "stop" doesn't fire on "bus stop" or "non-stop". */
function containsWholePhrase(message: string, phrase: string): boolean {
  return new RegExp(`(^|\\W)${escapeRegExp(phrase)}($|\\W)`, "i").test(message);
}

/** Whether `message` expresses wanting to exit the active flow. */
export function shouldExitFlow(
  message: string,
  cancelKeywords: string[] = DEFAULT_CANCEL_KEYWORDS,
): boolean {
  return cancelKeywords.some((keyword) => containsWholePhrase(message, keyword));
}
