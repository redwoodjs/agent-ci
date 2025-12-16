# 2025-12-16 - Query raw mode for MCP

## Problem
Cursor MCP clients already include an LLM. The current query endpoint returns an LLM-produced answer, which duplicates work when the client will re-process the same context.

## Context
- `scripts/query.sh` calls `/rag/query` and prints `.response`.
- Cursor integration includes both ingestion (hooks) and an MCP server entrypoint.
- Architecture docs describe the system flow and the knowledge synthesis engine. Some parts (RAG, Evidence Locker) might be phased out later, but this task focuses on query output modes.

## Plan
- Read architecture docs and recent work logs for the current query flow and prompt shape.
- Locate the `/rag/query` route and identify where prompt/context is assembled and where the LLM call happens.
- Design two query modes:
  - LLM mode: current behaviour.
  - Raw/agent mode: returns the prompt/context that would have been sent to the LLM (or an agent-oriented variant) without invoking the LLM.
- Define endpoint parameters and response shape so `scripts/query.sh` and the Cursor MCP server can select the mode.

## Findings
- `/rag/query` is implemented in `src/app/engine/routes.ts` and returns JSON `{ response }`.
- The handler already supports `momentGraphNamespace` / `namespace` and temporarily sets `MOMENT_GRAPH_NAMESPACE` for the duration of the request.
- The Cursor MCP client (`src/app/ingestors/cursor/scripts/mcp-server.ts`) calls `POST /rag/query` with `{ query }` and returns the `.response` string as the tool result.
- The engine query pipeline has two distinct prompt-producing points:
  - Narrative path: builds a narrative prompt from Moment Graph timeline text, then calls the LLM.
  - Evidence Locker path: builds an LLM prompt via plugin hooks (`composeLlmPrompt`), then calls the LLM.
- There is currently a mismatch between `routes.ts` and `engine.ts` for Evidence Locker enablement: `routes.ts` forwards an `enableEvidenceLocker` option, but `engine.ts` currently forces Evidence Locker off inside `query()`.

## Decisions
- Change `/rag/query` to return plain text for all modes.
- Add `responseMode` to `/rag/query`.
  - `answer`: current behaviour (calls the LLM).
  - `brief`: returns a narrative briefing for an agent without calling the LLM.
  - `prompt`: returns the exact narrative prompt text without calling the LLM.
- Remove the Evidence Locker enable flag end-to-end. The query path will not switch to Evidence Locker, and the Evidence Locker query code can remain unused until it is either reconnected or removed.
- Update the Cursor MCP server and `scripts/query.sh` to treat `/rag/query` as a text response.
