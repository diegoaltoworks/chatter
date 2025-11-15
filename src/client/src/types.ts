/**
 * Shared types for the chatbot client
 */

export type ChatMode = "public" | "private";

export interface ChatBotConfig {
  /** Host of the DiegoBot API (e.g., 'api.example.com' - protocol will be added automatically) */
  host: string;
  /** Either 'public' or 'private' */
  mode: ChatMode;
  /** API key for authentication */
  apiKey: string;
  /** Access token (required only for 'private' mode) */
  token?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  reply: string;
}

export interface StreamCallbacks {
  onChunk: (delta: string) => void;
  onEnd?: () => void;
  onError?: (error: Error) => void;
}

export interface ChatConfig extends ChatBotConfig {
  /** Container element to render the chat (required for Chat component) */
  container: HTMLElement | string;
  /** Placeholder text for input */
  placeholder?: string;
  /** Initial messages to display */
  initialMessages?: ChatMessage[];
  /** Title of the chat window */
  title?: string;
  /** Subtitle or description */
  subtitle?: string;
  /** Callback when close button is clicked (mobile only) */
  onClose?: () => void;
}

export interface ChatButtonConfig extends ChatBotConfig {
  /** Position of the button */
  position?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  /** Button text or icon */
  label?: string;
  /** Custom styles */
  styles?: Partial<CSSStyleDeclaration>;
  /** Chat window configuration */
  chatConfig?: Partial<Omit<ChatConfig, "host" | "mode" | "apiKey" | "token">>;
}
