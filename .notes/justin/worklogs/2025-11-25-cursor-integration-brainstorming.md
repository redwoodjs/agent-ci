# 2025-11-25: Cursor Integration Brainstorming

## Problem
We have a working RAG engine (Machinen) running on Cloudflare Workers that indexes GitHub, Discord, etc. We want to integrate this knowledge into the Cursor editor experience. Specifically, when I ask a question in Cursor Chat, I want to surface relevant context from Machinen to augment the answer.

## Context
- **Machinen**: Cloudflare Worker-based system.
  - Ingests data (GitHub, Discord).
  - Stores in R2/Vectorize.
  - Has a Query API (presumably, or easy to add based on `rag/engine.ts`).
- **Goal**: "Brainstorm how we can brainstorm". Focus on the integration mechanism.
- **Vision**: I type in chat -> Machinen gets a cue -> Machinen provides context -> Cursor response is augmented or appended.

## Brainstorming Directions
1.  **MCP (Model Context Protocol)**: The standard way to give LLMs tools and context.
    - **Pros**: Native to Cursor. Allows the LLM to decide *when* to query Machinen. Context is "incorporated" naturally.
    - **Architecture**: A lightweight local MCP server acts as a proxy to the remote Machinen Cloudflare Worker.
2.  **VS Code Chat Participant API**:
    - **Pros**: Explicit control (`@machinen`). Can render custom responses.
    - **Cons**: Might require explicit invocation.
3.  **Global Context / Docs Integration**:
    - **Pros**: Always available.
    - **Cons**: Static docs vs dynamic RAG queries.

## Selected Direction: MCP (Pull-Based)

I'm going with the MCP approach. My main concern was "noise"—I don't want Machinen annoying the user with irrelevant info for every query.

MCP solves this perfectly because it is inherently **"pull-based"**. The Cursor Agent (the LLM) acts as the gatekeeper. It only calls the Machinen tool if *it* decides my query is relevant to the project's domain.

To ensure this works well, we will focus on **Tool Definition Engineering**:
- We can instruct the tool (via its description) to be used *only* for "questions about project architecture, history, or internal decisions," effectively silencing it for general coding questions.

### Deployment Strategy: Re-evaluating Local vs. Remote

I considered remote SSE on Cloudflare, but realized a flaw: **SSE keeps the worker hot**, which on Cloudflare (Standard Model) gets expensive or hits duration limits. Durable Objects + WebSockets is a robust alternative but complex for a simple tool.

**Wait, there is a third option**: The "Stdio Wrapper" that comes with the repo.
- **Idea**: We can check a `scripts/mcp-server.ts` into the repo.
- **Configuration**: Users just point Cursor to `node scripts/mcp-server.ts` (absolute path).
- **Benefit**: Zero "server management" for the user. Cursor manages the process lifecycle (starts it when opened, kills it when closed).
- **Requirement**: User must have the repo checked out (which they do, they are working on it!).

This seems like the sweet spot:
1.  **No external server costs** (the "server" is just a local node process).
2.  **Simple config** (One time setup in Cursor settings).
3.  **Secure** (API key stays local).

### Integration: Bundling with Existing Setup

We already have a setup script (`src/app/ingestors/cursor/scripts/setup.sh`) for the ingestion hooks. We can expand this concept to bundle the MCP setup as well.

**The "One Script" Vision**:
- We create a master setup script (or update the existing one).
- It sets up the ingestion hooks (pushing data *out*).
- It also helps configure the MCP server (pulling data *in*).
  - *Note*: Cursor currently requires manual UI entry for MCP servers. We can't programmatically add it yet.
  - *Mitigation*: The script can print the exact path and config values the user needs to paste into Cursor settings.

## Plan
- **Create `scripts/mcp-server.ts`**: A simple Node script using `@modelcontextprotocol/sdk`. It proxies requests to the Machinen Worker API.
- **Update `package.json`**: Add the SDK dependency.
- **Update Documentation**: Add instructions to `src/app/ingestors/cursor/README.md` on how to add the MCP server in Cursor.
