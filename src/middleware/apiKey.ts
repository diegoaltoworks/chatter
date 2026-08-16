/**
 * Constants shared by every middleware/route that reads the `x-api-key`
 * header, single-sourced so the header name and the debug-log preview
 * length can't drift out of sync between them.
 */

/** The header carrying a session key or a JWT API key. */
export const API_KEY_HEADER = "x-api-key";

/** How many leading characters of a key to include in a debug log line. */
export const API_KEY_PREVIEW_LENGTH = 20;
