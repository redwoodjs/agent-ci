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

## Implementation Steps
1.  [x] Create `src/app/ingestors/cursor/scripts/mcp-server.ts` (Local MCP Server)
    -   Import `@modelcontextprotocol/sdk` and `zod`.
    -   Implement `machinen_search` tool.
    -   Configure stdio transport.
    -   Implement fetch to `MACHINEN_API_URL/query`.
2.  [x] Create bundling infrastructure
    -   Created `scripts/build-mcp-server.mjs` using esbuild to bundle dependencies.
    -   Added `esbuild` to devDependencies.
    -   Added `build:mcp-server` script to package.json.
    -   Outputs to `dist/cursor/mcp-server.mjs` as a single executable bundle.
3.  [x] Update setup script
    -   Modified `src/app/ingestors/cursor/scripts/setup.sh` to build and copy the bundled MCP server.
    -   Copies bundled file to `$HOME/.cursor/hooks/machinen-mcp-server.mjs`.
    -   Prints setup instructions for Cursor configuration.
4.  [x] Update Documentation
    -   Updated "Knowledge Base Integration (MCP)" section in README.
    -   Reflects new bundled approach (no need for repo clone or TS runtime).

## Refinement: Bundling Approach

The initial implementation assumed users would have the Machinen repo cloned and Node could run TypeScript directly. This had several issues:
- Users might not have the repo (they just want to use the tool).
- Node cannot run TypeScript without compilation.
- Dependencies need to be bundled for a standalone executable.

**Solution**: Use esbuild to create a single bundled `.mjs` file with all dependencies included. The setup script:
1. Builds the bundle (`npm run build:mcp-server`).
2. Copies it to `~/.cursor/hooks/`.
3. Prints instructions for configuring it in Cursor.

This makes the MCP server completely self-contained and deployable without requiring the full repo or TypeScript tooling.

## Recent Progress: MCP Server Fixes and Configuration

### Fixed Server Startup Issues

**Problem**: The MCP server wasn't starting, causing "No server info found" errors in Cursor. The bundled file had a shebang (`#!/usr/bin/env node`) that caused a syntax error when running with `node file.mjs`.

**Solution**:
- Removed shebang from source TypeScript file
- Removed shebang banner from esbuild build script
- Server now starts correctly

### Fixed API Endpoint and Authentication

**Problem**: The server was using incorrect API endpoint (`/query` instead of `/rag/query`) and wrong auth header format (`x-api-key` instead of `Authorization: Bearer`).

**Solution**:
- Updated endpoint to `/rag/query` (routes are mounted under `/rag` prefix)
- Changed auth header from `x-api-key` to `Authorization: Bearer` format

### Added Comprehensive Debugging

**Added**:
- Logging to `/tmp/machinen-mcp-server.log` with timestamps
- Logs all server events: initialization, tool listing, tool calls, API requests/responses, errors
- Error handling with fallback to stderr if log file operations fail
- Made tool description permissive for debugging ("use it at all times")

### Switched to mcp.json Configuration

**Problem**: Initially tried manual UI configuration, but Cursor reads MCP servers from `mcp.json` files.

**Solution**:
- Updated setup script to create/update `.cursor/mcp.json` automatically
- Uses proper `mcpServers` structure with `type: "stdio"`
- Uses config interpolation variables (`${userHome}`, `${env:MACHINEN_API_KEY}`)
- Automatically merges into existing `mcp.json` files (overwrites `machinen` key if exists)
- Backs up existing configs before modifying

### Centralized Scripts

**Moved**:
- `src/app/ingestors/cursor/scripts/setup.sh` → `scripts/setup-cursor.sh`
- Updated all README references to new location
- Scripts now in centralized `scripts/` directory for better organization

### Current Status

The MCP server should now:
- Start correctly without syntax errors
- Be discovered by Cursor via `.cursor/mcp.json`
- Connect to the correct API endpoint with proper authentication
- Log all activity to `/tmp/machinen-mcp-server.log` for debugging

**Next Steps**: Test the integration end-to-end and verify tool calls work correctly.
