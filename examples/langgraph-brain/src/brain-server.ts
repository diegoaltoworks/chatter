#!/usr/bin/env bun
/**
 * LangGraph as Chatter's brain
 *
 * A tool-using LangGraph agent answers every chat turn via `answerFn`, while
 * Chatter keeps doing everything around it: retrieval and prompt assembly
 * upstream (the agent receives the fully assembled system prompt, context and
 * all), auth, rate limiting and output guardrails downstream.
 *
 * Usage:
 *   Set OPENAI_API_KEY, TURSO_URL, TURSO_AUTH_TOKEN, CHATTER_SECRET
 *   bun run src/brain-server.ts
 */

import { createServer } from "@diegoaltoworks/chatter";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

// A single example tool. A real deployment would add whatever the agent
// needs — order lookups, calendar access, internal APIs — Chatter never
// sees these; they live entirely on the brain side of `answerFn`.
const lookupOrderStatus = tool(
  async ({ orderId }: { orderId: string }) => `Order ${orderId} is in transit, arriving in 2 days.`,
  {
    name: "lookup_order_status",
    description: "Look up the shipping status of an order by its id.",
    schema: z.object({ orderId: z.string() }),
  },
);

const agent = createReactAgent({
  llm: new ChatOpenAI({ model: "gpt-4o", apiKey: process.env.OPENAI_API_KEY }),
  tools: [lookupOrderStatus],
});

async function main() {
  const app = await createServer({
    bot: {
      name: "LangGraphBot",
      personName: "My Company",
      publicUrl: "https://bot.mycompany.com",
      description: "AI assistant backed by a LangGraph agent",
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || "",
    },
    database: {
      url: process.env.TURSO_URL || "",
      authToken: process.env.TURSO_AUTH_TOKEN || "",
    },
    auth: {
      secret: process.env.CHATTER_SECRET || "",
    },
    knowledgeDir: "./knowledge",
    promptsDir: "./prompts",
    answerFn: async ({ system, messages, mode, sender }) => {
      // `mode` ("public" | "private") and `sender` (identity, where the
      // surface knows one) are available here to vary agent behavior per
      // caller — e.g. enabling more tools, or a different system note, for
      // the private pipeline.
      const contextNote = sender ? `\n\nCaller: ${sender} (${mode} pipeline)` : `\n\n(${mode} pipeline)`;
      const result = await agent.invoke({
        messages: [
          new SystemMessage(system + contextNote),
          ...messages.map((m) => (m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content))),
        ],
      });
      const last = result.messages.at(-1);
      const content = last?.content;
      return typeof content === "string" ? content : JSON.stringify(content);
    },
  });

  const port = 8181;
  Bun.serve({ port, fetch: app.fetch });
  console.log(`LangGraph-backed Chatter server running on http://localhost:${port}`);
}

main();
