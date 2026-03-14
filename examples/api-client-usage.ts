#!/usr/bin/env node
/**
 * API Client Usage Example
 *
 * This example shows how to interact with a Chatter server
 * programmatically using fetch or any HTTP client.
 *
 * Usage:
 *   1. Have a Chatter server running (see http-server-basic.ts)
 *   2. Create an API key: bun bin/create-apikey.ts --name "my-client"
 *   3. Set CHATTER_API_KEY environment variable
 *   4. Run: bun run examples/api-client-usage.ts
 */

const CHATTER_URL = process.env.CHATTER_URL || "http://localhost:8181";
const API_KEY = process.env.CHATTER_API_KEY || "";

async function chatPublic(message: string) {
  const response = await fetch(`${CHATTER_URL}/api/public/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify({ message }),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return data.reply;
}

async function chatPublicWithHistory(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
) {
  const response = await fetch(`${CHATTER_URL}/api/public/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify({ messages }),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return data.reply;
}

async function chatPublicStreaming(message: string) {
  const response = await fetch(`${CHATTER_URL}/api/public/chat?stream=1`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ message }),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let fullResponse = "";

  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = JSON.parse(line.slice(6));
          if (data.delta) {
            process.stdout.write(data.delta);
            fullResponse += data.delta;
          }
        }
      }
    }
  }

  console.log(); // New line
  return fullResponse;
}

async function main() {
  console.log("🤖 Chatter API Client Examples\n");

  try {
    // Example 1: Simple single message
    console.log("Example 1: Single message");
    console.log("Question: What is your return policy?");
    const reply1 = await chatPublic("What is your return policy?");
    console.log("Reply:", reply1);
    console.log();

    // Example 2: Conversation with history
    console.log("Example 2: Conversation with history");
    const conversation = [
      { role: "user" as const, content: "What is your return policy?" },
      { role: "assistant" as const, content: "We offer 30-day returns..." },
      { role: "user" as const, content: "What about international orders?" },
    ];
    console.log("Conversation:", conversation);
    const reply2 = await chatPublicWithHistory(conversation);
    console.log("Reply:", reply2);
    console.log();

    // Example 3: Streaming response
    console.log("Example 3: Streaming response");
    console.log("Question: Tell me about your company");
    console.log("Reply (streaming): ");
    await chatPublicStreaming("Tell me about your company");
    console.log();

    console.log("✅ All examples completed successfully");
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

main();
