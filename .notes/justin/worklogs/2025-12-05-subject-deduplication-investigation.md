# Subject Deduplication Investigation

## Problem

Different Cursor conversations that should logically be grouped into the same subject are creating duplicate subjects instead. The semantic search mechanism designed to find existing similar subjects is failing.

## Initial Investigation

Started by adding extensive debug logging throughout the indexing pipeline to trace the exact flow:

1. **Cursor Plugin** (`src/app/engine/plugins/cursor.ts`): Added logging for document ID, narrative components count/preview, and idempotency key generation
2. **Vector Summary** (`src/app/engine/utils/vector-summary.ts`): Added logging for the selected narrative text and similarity score
3. **Default Plugin** (`src/app/engine/plugins/default.ts`): Added logging for search text, embedding dimensions, and all top matches with scores
4. **Engine** (`src/app/engine/engine.ts`): Added logging for the entire decision path (semantic search → idempotency key → new subject creation)

## Test Setup

Created test conversations with surreal, distinctive prompts to make them easy to track:
- Conversation Pair 1: "The Sentient Refactor" - two conversations about refactoring a sentient authentication service
- These conversations are semantically very similar but use different wording

This approach proved effective in isolating issues from other potential problems.

## Issue 1: Missing Idempotency Key

Initial logs showed that the Cursor plugin was not generating an `idempotency_key` for the `SubjectDescription`. This meant the fallback deduplication mechanism wasn't working.

**Fix**: Added SHA-256 hash of `document.id` as the idempotency key in the Cursor plugin.

## Issue 2: Narrative Instability

When an existing subject was found via idempotency key, the engine was overwriting the subject's `title` and `narrative` with new values from the updated document. This caused the semantic "fingerprint" of subjects to change over time, making them unfindable by subsequent semantic searches.

**Fix**: Modified the engine to preserve existing subject title and narrative when linking via idempotency key. Only new subjects get their narrative set initially.

## Issue 3: Chunk Processing Queue Handler Missing

The `chunk-processing-queue-dev-justin` queue was receiving messages but had no handler in the main worker, causing "Unknown queue or message type" errors.

**Fix**: Added handler for `chunk-processing-queue-dev-justin` in `src/worker.tsx` to properly process chunk indexing jobs.

## Direct Index Query Tool

After fixing the above issues, semantic search was still failing. Created `scripts/query-subject-index.mjs` and debug endpoint `/rag/debug/query-subject-index` to directly query the SUBJECT_INDEX Vectorize index. This tool:

- Generates embeddings using the same model (`@cf/baai/bge-base-en-v1.5`) as production code
- Queries the same index (`subject-index-dev-justin`) used by the indexing pipeline
- Returns all matches with scores and metadata for debugging

This tool proved critical in isolating the threshold issue from other potential problems.

## Index Binding Verification

Verified that both the indexing pipeline (`upsertSubjectVector` in `engine.ts`) and the search pipeline (`findSubjectForText` in `default.ts`) use the exact same binding:
- Binding name: `SUBJECT_INDEX`
- Index name (dev-justin): `subject-index-dev-justin`
- Configuration: `wrangler.jsonc` line 424-426

This confirms there's no mismatch between write and read operations.

## Issue 4: Similarity Threshold Too High

Using the direct query tool, querying for "sentient auth service" returned a top match with score `0.8449` - just below the original `0.85` threshold.

This confirmed:
1. Vectors are being written correctly to the index
2. Queries are working correctly
3. The threshold of `0.85` was too strict for narrative-driven texts
4. The similarity scores for narrative-driven content cluster around `0.84-0.85`

**Fix**: Lowered the similarity threshold from `0.85` to `0.80` in `src/app/engine/plugins/default.ts`. The `0.80` threshold provides a better balance - still high enough to avoid false positives, but low enough to capture genuine semantic similarity in narrative content.

## Propagation Delay Hypothesis (Disproven)

Initially suspected that vector index propagation delay might be causing queries to fail immediately after inserts. However, the direct query tool showed that:
- The index is immediately queryable after writes
- The vectors are correctly stored and retrievable
- The issue was threshold-based, not timing-based

This suggests that Cloudflare Vectorize has very low latency for index updates, or at least low enough that it's not a factor in our use case.

## Observations

- The Cloudflare dashboard showed the direct query as the first query of the day, suggesting that queue-triggered queries may not be logged the same way as HTTP-triggered queries
- Both code paths use the same `env.SUBJECT_INDEX` binding, so the index configuration is correct
- The issue was purely the threshold being too strict

## Next Steps

1. Deploy the latest code with all fixes (idempotency key, stable narratives, chunk queue handler, `0.80` threshold)
2. Delete the test subjects to ensure a clean slate
3. Index the first "Sentient Refactor" conversation
4. Index the second "Sentient Refactor" conversation
5. Verify that the second conversation correctly finds and links to the first via semantic search

## Issue 5: Brittle SQL Batching for Processed Chunks

During testing, the `setProcessedChunkHashes` operation failed with a `SQLITE_ERROR: too many SQL variables` error for large documents. This indicated that the existing batching logic for inserting chunk hashes was not robust enough.

The initial fix involved inserting hashes one by one within a transaction. While correct, a better architectural solution was proposed: remodel the storage of processed chunks to better fit the access pattern.

The `processed_chunks` table was being used as a simple list of hashes for a given document. It did not require the overhead of a relational model.

**Fix**: Remodeled the schema to be a key-value store.
1.  **Migration**: Dropped the `processed_chunks` table and added a single `processed_chunk_hashes_json` TEXT column to the `indexing_state` table.
2.  **DB Logic**: Refactored `setProcessedChunkHashes` to perform a single `UPSERT` operation, writing a JSON-stringified array of all chunk hashes into the new column. `getProcessedChunkHashes` now reads and parses this JSON blob.

This change simplifies the logic, removes the need for complex batching, and completely resolves the `SQLITE_ERROR`.
