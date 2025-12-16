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

## Implementation notes
- Updated `src/app/engine/routes.ts`:
  - Reads `responseMode` from JSON body or query string.
  - Calls engine `query(..., { responseMode })`.
  - Returns `text/plain` responses.
  - Removes any parsing/forwarding of Evidence Locker enable/disable flags.
- Updated `src/app/engine/engine.ts`:
  - Adds `responseMode` handling on the narrative path.
  - Removes Evidence Locker toggling from `query()` and always returns the narrative-miss message.
  - Moves the Evidence Locker query path into `queryEvidenceLocker(...)` so it remains available but is not called.
- Updated `scripts/query.sh`:
  - Adds `--response-mode` / `RESPONSE_MODE` support.
  - Posts `responseMode` to `/rag/query`.
  - Treats `/rag/query` responses as plain text.
  - Removes `DISABLE_EVIDENCE_LOCKER` handling and stops posting Evidence Locker flags.
- Updated Cursor MCP server (`src/app/ingestors/cursor/scripts/mcp-server.ts`):
  - Posts `responseMode` (defaults to `brief`, configurable via `MACHINEN_RESPONSE_MODE`).
  - Reads `/rag/query` responses as plain text.
- Updated `src/app/engine/README.md`:
  - Replaces the `/rag/query` response example with a plain text description.
  - Documents `responseMode`.
