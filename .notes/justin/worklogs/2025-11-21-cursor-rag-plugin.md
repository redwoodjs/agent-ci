# 2025-11-21: Cursor RAG Plugin

## Problem

We need to integrate Cursor conversation data into the RAG engine.

1.  **Storage Mismatch**: Currently, the Cursor ingestor stores data as fragmented "interaction pairs" (generations) at `cursor-conversations/{conversation_id}/{generation_id}.json`. The RAG engine is designed for a "page-centric" model where a single `latest.json` file represents the complete state of an entity (e.g., a full GitHub PR with comments). This fragmentation makes it difficult to retrieve and reconstruct the full context of a conversation.
2.  **Missing Plugin**: We need a `CursorPlugin` for the RAG engine to handle indexing (chunking conversations) and querying (reconstructing dialogue context).

## Analysis

### Current Ingestor State
*   **Route**: `POST /ingestors/cursor`
*   **State**: Uses `CursorEventsDurableObject` keyed by `generation_id`.
*   **Output**: Writes independent JSON files for each generation to R2.
*   **Issue**: There is no aggregation of the full conversation history.

### Desired State
*   **Storage**: A single `cursor/conversations/{conversation_id}/latest.json` file containing the full history of the conversation.
*   **Structure**:
    ```json
    {
      "id": "conversation_id",
      "generations": [
        {
          "id": "gen_1",
          "prompt": "...",
          "response": "...",
          "timestamp": "..."
        },
        ...
      ]
    }
    ```
*   **Concurrency**: To safely append to this list without race conditions (e.g., if multiple generations happen quickly), we should serialize updates through a Durable Object keyed by `conversation_id` instead of `generation_id`.

## Plan

### 1. Refactor Cursor Ingestor
*   **Change Scope**: Update the ingestion route to instantiate the Durable Object using `conversation_id` instead of `generation_id`.
*   **Update Logic**:
    *   The DO will still buffer events for the *current* generation (identified by `generation_id` in the event payload).
    *   When the `stop` event is received:
        1.  Aggregate the events for that specific generation.
        2.  Read the existing `latest.json` from R2 (or initialize a new one).
        3.  Append the new generation to the list.
        4.  Write the updated `latest.json` back to R2.
        5.  Clear the buffered events for that generation from the DO.
*   **Path Update**: Store at `cursor/conversations/{conversation_id}/latest.json` to match the `github/` pattern.

### 2. Implement RAG Plugin (`CursorPlugin`)
*   **`prepareSourceDocument`**:
    *   Match keys starting with `cursor/conversations/`.
    *   Parse `latest.json`.
    *   Create a `Document` where the content is a concatenation of the conversation (or maybe just the last interaction? No, likely the whole thing for the 'content' field, or a summary).
*   **`splitDocumentIntoChunks`**:
    *   Iterate through the `generations` array.
    *   Create a `Chunk` for each generation (User Prompt + Assistant Response).
    *   Metadata: `chunkId` (hash), `jsonPath` (e.g., `$.generations[0]`), `role` (user/assistant mixed), `timestamp`.
*   **`reconstructContext`**:
    *   Fetch `latest.json`.
    *   Identify relevant generations based on search results.
    *   Format as a readable dialogue transcript (e.g., `**User:** ... \n\n **Assistant:** ...`).
*   **`composeLlmPrompt`**:
    *   Reuse the default aggregator or adapt if necessary.

### 3. Data Migration
*   The existing data is in a different format and path. Since this is an internal tool and the volume is manageable, we will likely archive/delete the old `cursor-conversations/` data and start fresh with new ingestion to populate `cursor/conversations/`.

## Tasks

1.  [x] Refactor `src/app/ingestors/cursor/routes.ts` to use `conversation_id` for the DO.
2.  [x] Update `ingestHandler` to perform the Read-Modify-Write cycle for `latest.json` on `stop` event.
3.  [x] Implement `src/app/engine/plugins/cursor.ts`.
4.  [x] Register the new plugin in `src/app/engine/index.ts`.

## Implementation Summary

Cursor plugin implemented following the GitHub plugin pattern. Main differences:
- Chunks are created per generation (user prompt + assistant response pair)
- Content format: `User: {prompt}\nAssistant: {response}`
- Uses `jsonPath` to track which generation each chunk came from (e.g., `$.generations[0]`)
- Reconstructs context by formatting matched generations as dialogue transcripts

## Critical Bug Fix

During implementation, discovered that vectors were being inserted with only `documentId` in metadata instead of full `chunk.metadata`. This meant `source: "cursor"` wasn't being stored, so queries couldn't filter by source. Fixed by changing `metadata: { documentId: ... }` to `metadata: chunk.metadata` in indexing-worker.ts.

Also discovered the old `rag-index` had silent insertion failures (vectors accepted but not persisting). Created `rag-index-v2` and updated all configs to use it.

## PR Description

**Title:** Add Cursor RAG Plugin

**Description:**

Adds Cursor conversation support to the RAG engine. Follows the GitHub plugin pattern but adapted for conversation data.

**Approach:**
- Plugin chunks each generation (user prompt + assistant response) separately
- Content formatted as `User: {prompt}\nAssistant: {response}` for better embedding quality
- Uses `jsonPath` metadata to track generation position for context reconstruction
- Reconstructs context by formatting matched generations as readable dialogue transcripts

**Key differences from GitHub plugin:**
- GitHub chunks by comment/body sections; Cursor chunks by conversation turns
- GitHub has structured metadata (owner, repo, number); Cursor uses conversation-level metadata
- Context reconstruction formats as dialogue rather than markdown sections

**Bug fixes:**
- Fixed metadata insertion bug where only `documentId` was stored instead of full chunk metadata (prevented source filtering)
- Created `rag-index-v2` to replace `rag-index` which had silent insertion failures
- Fixed cursor plugin type issues in `reconstructContext` (was using `Chunk[]` instead of `ChunkMetadata[]`)

**Testing:**
- Verified cursor chunks are indexed and searchable
- Confirmed queries return cursor conversation context correctly

---

## PR Description

**Title:** Fix Cursor RAG Plugin Search and Metadata Issues

**Description:**

Fixes the Cursor RAG plugin so queries actually return Cursor conversation results. The plugin was already merged in an earlier PR, but search wasn't working.

**What was already done (previous PR):**
- Cursor ingestor refactored to save conversations as `latest.json` files
- Initial Cursor RAG plugin implementation
- Basic indexing pipeline working

**What this PR fixes:**
- **Metadata insertion bug**: Vectors were only storing `documentId` instead of full chunk metadata, so `source: "cursor"` wasn't being stored and queries couldn't filter by source
- **Index issue**: Old `rag-index` had silent insertion failures (vectors accepted but not persisting). Created `rag-index-v2` and updated configs
- **Type issues**: Fixed cursor plugin `reconstructContext` using wrong types (`Chunk[]` instead of `ChunkMetadata[]`)
- **Cleanup**: Removed all debug logging

**Result:**
- Cursor chunks are now properly indexed with full metadata
- Queries successfully return Cursor conversation context
- Search works end-to-end

**Post-deployment note:**
After switching to `rag-index-v2`, the `EngineIndexingStateDO` still contains etags from the old index. This causes the scanner to skip files that aren't actually in the new index. Added `/admin/clear-indexing-state` endpoint to clear the DO state and force re-indexing. Should be called after switching Vectorize indexes.

