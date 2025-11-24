# Cursor Vectorize Debugging - Why Cursor Chunks Aren't Ranking

## Problem

Cursor conversation data is being indexed into Vectorize, but when querying, Cursor chunks are not appearing in search results or ranking high enough. GitHub results dominate even when querying for exact phrases that exist in Cursor data (e.g., "silver foxes", "the fox has jumped the nightingale", "the eagles in the fox nest").

## Context

- Cursor data is stored in R2 as `cursor/conversations/{conversation_id}/latest.json`
- The cursor plugin extracts user prompts and assistant responses, creating chunks with format: `User: {prompt}\nAssistant: {response}`
- Embeddings are generated using `@cf/baai/bge-base-en-v1.5` (768 dimensions)
- GitHub chunks work fine and appear in search results
- Indexing logs show successful insertion of Cursor chunks

## Attempt 1: Increased topK and Removed Result Limiting

**What we tried:**
- Increased `topK` from default to 50 in `performVectorSearch`
- Removed `.slice(0, 10)` that was truncating results after Vectorize query
- Added logging to show all 50 search results with scores and source breakdown

**Findings:**
- All 50 results were being returned, but still no Cursor chunks appeared
- Logs showed GitHub results dominating even with exact phrase queries
- Cursor chunks were not in the top 50 results at all

## Attempt 2: Added Missing Metadata Fields

**What we tried:**
- Added `source: "cursor"` to chunk metadata (was missing)
- Added `documentTitle` and `author` fields to match `ChunkMetadata` interface
- Added `id`, `documentId`, and `source` to the `Chunk` object itself

**Findings:**
- Metadata structure now matches the interface
- Still no Cursor chunks appearing in search results
- Verification queries by `source: "cursor"` returned 0 matches

## Attempt 3: Added Verification Query After Insertion

**What we tried:**
- Added immediate verification query after inserting vectors
- Query used dummy zero vector with filter `{ documentId: ... }`
- Checked if chunks were findable immediately after insertion

**Findings:**
- Verification query found **0 matches** even immediately after successful insertion
- This suggested either:
  - Eventual consistency delay longer than expected
  - Silent insertion failure
  - Metadata filtering not working

## Attempt 4: Added Delay for Eventual Consistency

**What we tried:**
- Added 5-second delay after insertion before verification query
- Added fallback query by `source: "cursor"` if documentId query failed
- Added logging to show sample vector metadata before insertion

**Findings:**
- Still found 0 matches after 5-second delay
- Query by `source: "cursor"` also returned 0 matches
- Sample metadata looked correct before insertion

## Attempt 5: Test Variations with Different Metadata Structures

**What we tried:**
- Created test suite that inserts 5 variations of metadata:
  - Test 0: No metadata (`{}`)
  - Test 1: `documentId` only
  - Test 2: `documentId` + `source`
  - Test 3: `documentId` + `source` + `chunkId`
  - Test 4: Full metadata (all fields)
- Each test vector uses the same embedding but different metadata
- Query each variation after 5-second delay to see which structure works

**Findings:**
- **All tests failed**: No test vectors found by any query method
- Test 0 (no metadata): Similarity search found 10 matches, but none were our test vectors (found GitHub chunks instead)
- Tests 1-4: All filtered queries returned 0 matches
- Test vectors were inserted with IDs like `test-1763992258442-0` through `test-1763992258442-4`
- Similarity search returned IDs like `e247965c46d06d86` (hashed IDs, likely GitHub chunks)

## Attempt 6: Expanded Similarity Search to topK=50 with returnMetadata

**What we tried:**
- Increased `topK` from 10 to 50 for Test 0 similarity search (Cloudflare Vectorize limit with metadata)
- Changed `returnMetadata` to `true` (was considering `"indexed"` but kept as boolean)
- Added logging to show:
  - Rank if test vector found
  - Top 10 vector IDs and scores
  - All test vector IDs found in results (not just the one being searched)

**Findings:**
- **All 5 test variations still failed**
- Test 0 (no metadata): Similarity search returned 50 matches, but **none were test vectors**
  - Looking for: `test-1764017097910-0`
  - Top results were hashed IDs (e.g., `e247965c46d06d86`, `a8ab4b6dc568d173`) - likely GitHub chunks
  - Test vectors found in results: **0**
- Tests 1-4: All filtered queries returned **0 matches**
  - Query by `documentId`: 0 matches
  - Query by `source`: 0 matches
- Insertion appeared successful: IDs logged as `["test-1764017097910-0","test-1764017097910-1","test-1764017097910-2","test-1764017097910-3","test-1764017097910-4"]`
- No errors thrown during insertion

## Key Observations

1. **Insertion appears successful**: No errors thrown, logs show "Successfully inserted X chunks" and test vector IDs are logged
2. **Vectors not queryable by any method**: Even with 5-second delay and topK=50, test vectors don't appear in similarity search results
3. **Metadata filtering completely broken**: All filtered queries return 0 matches regardless of metadata structure (empty, documentId only, documentId+source, full metadata)
4. **Similarity search finds other vectors**: When querying without filter, we get GitHub chunks (hashed IDs) but not our test/Cursor vectors
5. **Vector IDs differ**: Test vectors use IDs like `test-{timestamp}-{idx}`, while similarity search returns hashed IDs like `e247965c46d06d86`
6. **Same embedding doesn't match**: Test vectors inserted with the exact same embedding as the query vector don't appear in top 50 results

## Hypotheses

1. **Silent insertion failure**: Insert might succeed (no errors) but vectors aren't actually stored in Vectorize
2. **Eventual consistency delay**: Vectorize may need much longer than 5 seconds (possibly 30+ seconds or minutes) to make vectors searchable
3. **Vector ID format issue**: Test vector IDs (`test-*`) might not be compatible with Vectorize's internal ID system or validation
4. **Metadata indexing issue**: Metadata might not be indexed correctly, making filtered queries fail completely
5. **Index/namespace issue**: Test vectors might be inserted into a different index or namespace than queries are searching
6. **Vectorize API bug**: There might be a bug in Vectorize where `insert()` succeeds but vectors aren't persisted

## Next Steps

- Try querying with much longer delay (30+ seconds or 1+ minute) to test eventual consistency hypothesis
- Try querying by exact vector ID (if Vectorize supports direct ID lookup)
- Verify if regular Cursor chunks (not test vectors) use the same ID format as GitHub chunks - check if they're hashed
- Check if test vectors can be found by querying with a different embedding (maybe the exact same embedding causes issues?)
- Check Vectorize documentation for:
  - Metadata filtering requirements and limitations
  - Eventual consistency guarantees
  - Vector ID format restrictions
  - Known issues with `insert()` API
- Consider inserting a test vector with a hashed ID format (like GitHub chunks use) to see if ID format matters

