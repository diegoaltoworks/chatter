/**
 * assistant-ui + Chatter
 *
 * A custom ChatModelAdapter streams from Chatter's OpenAI-compatible
 * endpoint (/v1/chat/completions); assistant-ui primitives render the
 * thread. Swap in the styled Thread component from assistant-ui's
 * shadcn setup for a production look.
 */

import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
} from "@assistant-ui/react";

// Point these at your Chatter server + API key
// (create a key with: bunx chatter)
const CHATTER_URL = import.meta.env.VITE_CHATTER_URL ?? "http://localhost:8181";
const CHATTER_API_KEY = import.meta.env.VITE_CHATTER_API_KEY ?? "YOUR_CHATTER_API_KEY";

const chatterAdapter: ChatModelAdapter = {
  async *run({ messages, abortSignal }) {
    const res = await fetch(`${CHATTER_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CHATTER_API_KEY}`,
      },
      body: JSON.stringify({
        stream: true,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
        })),
      }),
      signal: abortSignal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`Chatter request failed (${res.status})`);
    }

    // Parse the SSE stream; each yield replaces the message content, so we
    // accumulate the text and yield the running total.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const event of events) {
        const line = event.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const data = line.slice("data: ".length);
        if (data === "[DONE]") continue;
        const delta = JSON.parse(data).choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          yield { content: [{ type: "text" as const, text }] };
        }
      }
    }
  },
};

const UserMessage = () => (
  <MessagePrimitive.Root className="msg msg-user">
    <MessagePrimitive.Content />
  </MessagePrimitive.Root>
);

const AssistantMessage = () => (
  <MessagePrimitive.Root className="msg msg-assistant">
    <MessagePrimitive.Content />
  </MessagePrimitive.Root>
);

export function App() {
  const runtime = useLocalRuntime(chatterAdapter);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="chat">
        <h1>Chatter + assistant-ui</h1>
        <ThreadPrimitive.Root className="thread">
          <ThreadPrimitive.Viewport className="viewport">
            <ThreadPrimitive.Empty>
              <p className="empty">Ask me anything.</p>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          </ThreadPrimitive.Viewport>
          <ComposerPrimitive.Root className="composer">
            <ComposerPrimitive.Input className="input" placeholder="Type a message…" />
            <ComposerPrimitive.Send className="send">Send</ComposerPrimitive.Send>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.Root>
      </div>
    </AssistantRuntimeProvider>
  );
}
