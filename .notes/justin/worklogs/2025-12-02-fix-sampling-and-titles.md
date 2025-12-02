# Work Log: Fixes for Sampling, Title Generation, and Volume Issues

**Date:** 2025-12-02

## 1. Problem

After deploying the "whale" fix (incremental indexing), we continued to observe issues:
1.  **Log Sampling:** High volume of logs suggesting we are still re-processing large documents.
2.  **Title Generation Failures:** Errors like `[engine] No plugin could generate a title for new subject from chunk...`.
3.  **SQL Variables Error:** `SQLITE_TOO_MANY_VARIABLES` (or similar) reported, though less frequent.

## 2. Investigation & Findings

### 2.1. The "Whale" Re-surfacing (Hash Instability)
The incremental indexing relies on `chunk.contentHash` to skip already processed chunks.
For Cursor conversations (`cursor.ts`), if the plugin fails to extract structured text (user prompt/assistant response), it falls back to `JSON.stringify(gen.events)`.
These events often contain **unstable fields** like `timestamp` or `sent_at`. Even if the conversation content hasn't changed, a new export/ingestion with updated timestamps results in a **new hash**.
This causes the engine to treat *every* chunk as new, bypassing the diffing optimization and flooding the system (hence the sampling and volume).

### 2.2. Title Generation Failures
The `generateSubjectTitle` hook in `default.ts` calls Workers AI.
If the AI call fails (e.g., rate limiting due to the volume mentioned above) or returns an empty/invalid response, the hook returns an empty string.
The engine then logs an error and **skips** the chunk entirely, causing data loss for that chunk's subject association.
The logs showed thousands of these errors, confirming that the volume was overwhelming the AI service or the inputs (JSON dumps) were confusing the model.

### 2.3. "Too Many SQL Variables"
This error usually occurs when inserting too many rows in a single `INSERT` statement.
We verified that `setProcessedChunkHashes` in `src/app/engine/db/index.ts` correctly implements batching (batch size 200).
It is likely that this error was either:
*   Caused by a different, less frequent bulk operation (not found in current search).
*   Or a side effect of the sheer volume of chunks being processed due to the hash instability, potentially hitting edge cases in other DB interactions (though `putSubject` is single-row).
Fixing the volume issue should alleviate the pressure that might lead to this.

## 3. Solutions

### 3.1. Strict Content Extraction for Cursor Events
Modified `src/app/engine/plugins/cursor.ts` to **remove the JSON fallback**.
*   **Action:** If the plugin fails to extract structured text (user prompt/assistant response), it now **throws an error immediately**.
*   **Rationale:** "Explode violently" policy. Rather than silently falling back to a potentially unstable JSON dump (which causes re-indexing storms), we want to fail hard so we can identify and fix the missing event types in the extraction logic.

### 3.2. Strict Title Generation (No Fallbacks)
Modified `src/app/engine/plugins/default.ts`:
*   **Action:** Removed the `"Untitled Subject"` fallback. If AI generation fails, it now **throws an error immediately**.
*   **Rationale:** "Explode violently" policy. We prefer to fail index jobs explicitly rather than accumulating low-quality data ("Untitled Subject") that silently hides underlying issues with the AI service or prompts.

## 4. Next Steps
*   Monitor logs for `[cursor-plugin] Failed to extract content` errors. These will point to new event types we need to handle.
*   Monitor logs for title generation failures. If these are frequent, we must address the root cause (AI stability, prompts) rather than masking them.
*   Monitor logs to verify that "whale" documents (large Cursor chats) are now being correctly diffed and skipped (assuming extraction succeeds).
