# LangGraph + Chatter

Two ways to combine Chatter with a [LangGraph](https://langchain-ai.github.io/langgraphjs/)
graph, matching the two seams Chatter exposes for graph frameworks.

## 1. LangGraph as Chatter's brain (`src/brain-server.ts`)

A tool-using LangGraph agent (`createReactAgent`) answers every chat turn via
[`answerFn`](../../docs/integrations.md#bringing-your-own-brain-answerfn).
Chatter still owns retrieval, prompt assembly, auth, rate limiting and output
guardrails - the agent only receives the assembled system prompt and the
conversation, and returns the answer text.

```bash
export OPENAI_API_KEY="sk-..."
export TURSO_URL="libsql://..."
export TURSO_AUTH_TOKEN="..."
export CHATTER_SECRET="your-secret-key"

bun install
bun run brain-server
```

## 2. Chatter as a node inside a LangGraph app (`src/graph-node.ts`)

A `ChatOpenAI` model pointed at Chatter's `/v1/chat/completions` endpoint acts
as one node in a larger graph. Chatter contributes a RAG-grounded,
guardrailed answer; the rest of the graph - other models, tools, formatting
steps - is free to build around it.

```bash
# 1. Run a Chatter server (see the repo README), then create an API key
# (needs the same CHATTER_SECRET the server was started with):
export CHATTER_SECRET="your-secret-key"
bunx chatter create-apikey

# 2. Run the graph:
export CHATTER_URL="http://localhost:8181"
export CHATTER_API_KEY="<key-from-step-1>"
bun run graph-node
```

## Which one do I want?

See [docs/integrations.md](../../docs/integrations.md) for the full writeup -
short version: reach for a graph when a turn needs multiple LLM/tool steps
that Chatter's linear pipeline doesn't model; when a turn is "retrieve, then
answer," Chatter's built-in pipeline (optionally with
[flows](../../docs/flows.md) for multi-turn slot filling) is enough on
its own, no graph framework required.

Chatter's core has no LangGraph dependency - `@langchain/*` only appears in
this example's own `package.json`.
