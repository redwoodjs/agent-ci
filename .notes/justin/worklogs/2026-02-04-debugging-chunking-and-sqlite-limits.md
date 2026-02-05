# Fixing Chunking and SQLITE_TOOBIG Failures [2026-02-04]

## Investigating New Production Errors
We are seeing two new errors in production:
1. `No plugin could split document into chunks` for Discord (`.jsonl`).
2. `string or blob too big: SQLITE_TOOBIG` for Cursor conversations.

We have a-priori approval to proceed with the Bedrock Protocol.

## Investigating 'No plugin could split document into chunks'
This error is occurring for the same Discord key we just 'fixed'. It seems that while we can now 'prepare' the document, the next phase (`micro_batches`) is failing to 'split' it.

## Investigating 'SQLITE_TOOBIG'
This seems to happen when saving artifacts for large Cursor conversations. The resulting JSON string likely exceeds SQLite/D1 limits.

## Work Task Blueprint: Robust Chunking and Artifact Storage

### Context
1. **No plugin could split document into chunks**: This happens because `pluginPipeline.ts` throws an error if any matching plugin returns an empty array. Some files (like empty Discord `.jsonl` or empty GitHub updates) are valid but contain no content to chunk.
2. **SQLITE_TOOBIG**: Artifact storage saves the entire output of each phase to a single SQLite row. For phases like `micro_batches` on large documents (e.g., Cursor conversations), the metadata can exceed the 1MB SQL/parameter limit.

### Proposed Changes

#### [MODIFY] `src/app/engine/indexing/pluginPipeline.ts`
- Relax `splitDocumentIntoChunks` to return an empty array if a plugin matched but produced no chunks, instead of throwing.

#### [MODIFY] `src/app/engine/runtime/strategies/simulation.ts`
- Update `ArtifactStorage.save` to detect large payloads.
- If `output_json` exceeds 512KB (safety threshold), write it to R2 instead and store a pointer in the database (e.g., `{ "__offloaded_to_r2__": true, "key": ... }`).
- Update `ArtifactStorage.load` to transparently fetch from R2 if it sees the pointer.

#### [MODIFY] `src/app/engine/plugins/discord.ts`
- Revert the previous 'minimal chunk' hack if we relax the pipeline check, OR keep it as a double-safety.

### Verification
- Manual verification of large Cursor doc ingestion.
- Verification of empty Discord doc ingestion.


## Fixes Implemented [2026-02-04]

### 1. Robust Chunking
We updated `pluginPipeline.ts` to differentiate between a total lack of plugin matching (error) and a plugin matching but producing zero chunks (valid for empty documents). This allows empty Discord `.jsonl` files to proceed through the pipeline without crashing.

### 2. Transparent R2 Artifact Offloading
We implemented a size-based offloading mechanism in `ArtifactStorage`:
- Payloads exceeding 512KB are automatically written to R2.
- A lightweight JSON pointer is stored in the SQLite database.
- `ArtifactStorage.load` transparently resolves these pointers, ensuring downstream phases are unaware of the offloading.
- Updated `simulation-worker.ts` to provide the necessary `env` context to the storage strategy.

These changes resolve the `SQLITE_TOOBIG` errors encountered with large Cursor conversations.
