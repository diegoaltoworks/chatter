/**
 * Conversation ID Generation
 */

/**
 * Generate a unique conversation ID
 *
 * Format: conv_{timestamp}_{random}
 * Example: conv_1710421200000_abc123xyz
 *
 * @returns Unique conversation ID string
 */
export function generateConversationId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 11);
  return `conv_${timestamp}_${random}`;
}

/**
 * Get or generate conversation ID
 *
 * @param providedId - Optional conversation ID provided by client
 * @returns The provided ID or a newly generated one
 */
export function getOrGenerateConversationId(providedId: string | undefined): string {
  return providedId || generateConversationId();
}

/**
 * Validate conversation ID format
 *
 * @param id - Conversation ID to validate
 * @returns true if valid format, false otherwise
 */
export function isValidConversationId(id: string): boolean {
  // Valid format: conv_{timestamp}_{random} or any non-empty string
  return typeof id === "string" && id.length > 0;
}
