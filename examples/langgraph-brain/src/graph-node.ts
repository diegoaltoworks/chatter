#!/usr/bin/env bun
/**
 * Chatter as a node inside a LangGraph app
 *
 * A `ChatOpenAI` model pointed at Chatter's OpenAI-compatible endpoint acts
 * as one node in a larger graph — Chatter contributes a RAG-grounded,
 * guardrailed answer; the rest of the graph is free to add whatever other
 * steps the app needs around it.
 *
 * Usage:
 *   1. Run a Chatter server (see repo README) with the OpenAI-compatible
 *      endpoint enabled (the default) and an API key created via
 *      `bunx chatter create-apikey`.
 *   2. CHATTER_URL=http://localhost:8181 CHATTER_API_KEY=<key> \
 *        bun run src/graph-node.ts
 */

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";

const chatterUrl = process.env.CHATTER_URL || "http://localhost:8181";

// `model` is accepted for wire compatibility but ignored — Chatter always
// answers with the model configured server-side.
const chatterModel = new ChatOpenAI({
  model: "chatter",
  apiKey: process.env.CHATTER_API_KEY || "",
  configuration: { baseURL: `${chatterUrl}/v1` },
});

const graph = new StateGraph(MessagesAnnotation)
  .addNode("askChatter", async (state) => {
    const response = await chatterModel.invoke(state.messages);
    return { messages: [response] };
  })
  .addNode("formatForDisplay", async (state) => {
    const last = state.messages.at(-1);
    const text = typeof last?.content === "string" ? last.content : "";
    return { messages: [new AIMessage(`> ${text.split("\n").join("\n> ")}`)] };
  })
  .addEdge(START, "askChatter")
  .addEdge("askChatter", "formatForDisplay")
  .addEdge("formatForDisplay", END)
  .compile();

async function main() {
  const result = await graph.invoke({
    messages: [new HumanMessage("What is your return policy?")],
  });
  console.log(result.messages.at(-1)?.content);
}

main();
