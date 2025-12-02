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

### 3.3. Foreign Key Constraint Fix
Modified `src/app/engine/db/index.ts` in `setProcessedChunkHashes`:
*   **Problem:** The `processed_chunks` table has a foreign key constraint referencing `indexing_state.r2_key`. When inserting chunk hashes, if no `indexing_state` row exists, the foreign key constraint fails.
*   **Action:** Before inserting into `processed_chunks`, check if an `indexing_state` row exists. If not, fetch the R2 object's ETag and create the row.
*   **Result:** Ensures the foreign key constraint is satisfied before inserting child records.

### 3.4. Removed Chunk-by-Chunk Correlation Fallback
Modified `src/app/engine/engine.ts`:
*   **Problem:** The engine was falling back to a "chunk-by-chunk" correlation logic if no plugin provided a top-down subject description, adding complexity and hiding configuration issues.
*   **Action:** Removed the fallback logic entirely. If no plugin's `determineSubjectsForDocument` hook returns a description, the engine now throws a fatal error.

### 3.5. Implemented `determineSubjectsForDocument` for Cursor
Modified `src/app/engine/plugins/cursor.ts`:
*   **Problem:** The `cursorPlugin` was not implementing the `determineSubjectsForDocument` hook, causing the engine to hit the (now removed) fallback.
*   **Action:** Implemented the hook to treat each entire Cursor conversation as a single subject. This provides the necessary top-down description and prevents chunk-by-chunk processing for cursor conversations.

### 3.6. Implemented `determineSubjectsForDocument` for GitHub and Discord
Modified `src/app/engine/plugins/github.ts` and `src/app/engine/plugins/discord.ts`:
*   **Problem:** The `githubPlugin` and `discordPlugin` were also missing the `determineSubjectsForDocument` hook.
*   **Action:** Implemented the hook in both plugins. For GitHub, each PR, Issue, or Project is a subject. For Discord, each thread or daily channel log is a subject.
*   **Result:** All source-specific plugins now provide top-down subject descriptions, completely removing the need for the chunk-by-chunk fallback logic.

## 5. Decision: Synchronous vs. Asynchronous Title Generation

A key observation was that subject titles were not descriptive (e.g., "Cursor Conversation <UUID>"). To provide meaningful, user-facing titles, an LLM call is needed. This led to a design decision about *when* to make this call.

### 5.1. The Options

1.  **Synchronous (Current Approach):** When a new subject is first created, make a blocking call to an LLM to generate a title. The indexing process for that subject waits for the title.
2.  **Asynchronous (Alternative):** Create the subject immediately with a placeholder title. Add a job to a queue for a separate worker to process, which calls the LLM and updates the title out-of-band.

### 5.2. Analysis & Decision

| Aspect | Synchronous | Asynchronous |
| :--- | :--- | :--- |
| **Complexity** | **Low**. A simple, direct function call. | **High**. Requires a queue, a worker, state management for "pending" titles, and retry logic. |
| **Data Integrity** | **High**. Subjects *always* have a meaningful title from the moment they are created. | **Low**. Subjects exist in an inconsistent, intermediate state with placeholder titles until the worker completes. |
| **Failure Mode** | **Immediate & Loud**. If title generation fails, the entire indexing job fails, aligning with the "explode violently" principle. | **Delayed & Quieter**. A failure in a background worker is less visible and could lead to silent data quality issues. |
| **Performance** | **Slower initial creation**. Adds latency to the creation of a *new* subject. | **Faster initial creation**. The critical path is not blocked by the LLM call. |

**Decision:** We will proceed with the **synchronous** approach.

The one-time performance cost of a blocking LLM call during subject creation is a worthwhile trade-off for the significant benefits in architectural simplicity, data integrity, and immediate, clear failure detection. The complexity of the asynchronous model introduces too many moving parts and potential for silent failures.

### 5.3. Implementation: Semantic Title Generation

*   **Action:**
    1.  Created a new centralized utility `src/app/engine/utils/summarize.ts` with a `generateTitleForText` function.
    2.  Modified the `determineSubjectsForDocument` hook in the `cursor` and `discord` plugins to call this utility, using the first chunk's content to generate a semantic title.
    3.  The `github` plugin will continue to use the high-quality titles from Issues and PRs directly.
*   **Result:** All new subjects will now have meaningful, LLM-generated titles upon creation, improving their utility for user-facing features and introspection.

### 5.4. Model Selection for Title Generation

*   **Problem**: Title generation is a high-volume, synchronous task. Using the powerful but expensive `gpt-oss-20b` model for this is inefficient.
*   **Decision**: After weighing the token costs vs. latency, a smaller, faster model is preferable for the synchronous title generation step. We will use `@cf/meta/llama-3.1-8b-instruct` as it prioritizes low latency, which is critical for a blocking operation in the indexing pipeline.
*   **Action**:
    1.  Updated `src/app/engine/utils/llm.ts` to use `@cf/meta/llama-3.1-8b-instruct` when the `"gpt-oss-20b-cheap"` model type is requested.
    2.  The `summarize.ts` utility already requests the `"gpt-oss-20b-cheap"` model, so no changes were needed there.
*   **Result**: This maintains the architectural separation of a fast/cheap model and a powerful/slow model, while selecting the most appropriate modern model for the high-volume, latency-sensitive task.

## 6. Next Steps
*   Monitor logs for `[cursor-plugin] Failed to extract content` errors. These will point to new event types we need to handle.
*   Monitor logs for title generation failures. If these are frequent, we must address the root cause (AI stability, prompts) rather than masking them.
*   Monitor logs to verify that "whale" documents (large Cursor chats) are now being correctly diffed and skipped (assuming extraction succeeds).
*   Verify that FOREIGN KEY constraint errors no longer occur during indexing.
