/**
 * Example usage of ChatBot
 */

const ChatBot = require("./chatbot.js");

// Example 1: Public mode - single message
async function publicExample() {
  const client = new ChatBot({
    host: "your-api-host.com",
    mode: "public",
    apiKey: "your-public-api-key",
  });

  try {
    // Send a single message
    const reply = await client.sendMessage("Hello, how can you help me?");
    console.log("Bot reply:", reply);
  } catch (error) {
    console.error("Error:", error.message);
  }
}

// Example 2: Public mode - conversation with history
async function publicConversationExample() {
  const client = new ChatBot({
    host: "your-api-host.com",
    mode: "public",
    apiKey: "your-public-api-key",
  });

  try {
    const conversation = [
      { role: "user", content: "What is your name?" },
      { role: "assistant", content: "I am DiegoBot, how can I help you?" },
      { role: "user", content: "What can you do?" },
    ];

    const reply = await client.sendConversation(conversation);
    console.log("Bot reply:", reply);
  } catch (error) {
    console.error("Error:", error.message);
  }
}

// Example 3: Staff mode - with access token
async function staffExample() {
  const client = new ChatBot({
    host: "your-api-host.com",
    mode: "staff",
    apiKey: "your-api-key",
    token: "your-access-token",
  });

  try {
    const reply = await client.sendMessage("Show me internal documentation");
    console.log("Bot reply:", reply);
  } catch (error) {
    console.error("Error:", error.message);
  }
}

// Example 4: Streaming response
async function streamingExample() {
  const client = new ChatBot({
    host: "your-api-host.com",
    mode: "public",
    apiKey: "your-public-api-key",
  });

  console.log("Bot reply: ");

  await client.streamMessage(
    "Tell me a short story",
    // onChunk - called for each piece of text
    (delta) => {
      process.stdout.write(delta);
    },
    // onEnd - called when streaming completes
    () => {
      console.log("\n[Stream ended]");
    },
    // onError - called if there's an error
    (error) => {
      console.error("\nError:", error.message);
    },
  );
}

// Example 5: Streaming a conversation
async function streamingConversationExample() {
  const client = new ChatBot({
    host: "your-api-host.com",
    mode: "staff",
    apiKey: "your-api-key",
    token: "your-access-token",
  });

  const conversation = [
    { role: "user", content: "Who are you?" },
    { role: "assistant", content: "I am DiegoBot, your AI assistant." },
    { role: "user", content: "Tell me more about yourself" },
  ];

  console.log("Bot reply: ");

  await client.streamConversation(
    conversation,
    (delta) => process.stdout.write(delta),
    () => console.log("\n[Stream ended]"),
    (error) => console.error("\nError:", error.message),
  );
}

// Uncomment to run examples:
// publicExample();
// publicConversationExample();
// staffExample();
// streamingExample();
// streamingConversationExample();
