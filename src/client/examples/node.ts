/**
 * Node.js example for @fyne/chatbot
 */

import { ChatBot } from "../src/index";

async function main() {
  const bot = new ChatBot({
    host: "bot.diegoalto.app",
    mode: "public",
    apiKey: "your-api-key-here",
  });

  console.log("=== Example 1: Send Message ===");
  try {
    const reply = await bot.sendMessage("What is the weather like today?");
    console.log("Reply:", reply);
  } catch (error) {
    console.error("Error:", error);
  }

  console.log("\n=== Example 2: Send Conversation ===");
  try {
    const messages = [
      { role: "user" as const, content: "What is your name?" },
      { role: "assistant" as const, content: "I am DiegoBot, an AI assistant." },
      { role: "user" as const, content: "What can you help me with?" },
    ];
    const reply = await bot.sendConversation(messages);
    console.log("Reply:", reply);
  } catch (error) {
    console.error("Error:", error);
  }

  console.log("\n=== Example 3: Stream Message ===");
  process.stdout.write("Reply: ");
  try {
    await bot.streamMessage("Tell me a short joke", {
      onChunk: (delta) => process.stdout.write(delta),
      onEnd: () => console.log("\n[Stream ended]"),
      onError: (error) => console.error("\nError:", error),
    });
  } catch (error) {
    console.error("Error:", error);
  }
}

main();
