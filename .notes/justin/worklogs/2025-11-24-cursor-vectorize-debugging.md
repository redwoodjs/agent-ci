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

## Attempt 6: Expanded Similarity Search to topK=100

**What we tried:**
- Increased `topK` from 10 to 100 for Test 0 similarity search
- Added logging to show:
  - Rank if test vector found
  - Top 10 vector IDs and scores
  - All test vector IDs found in results (not just the one being searched)

**Findings:**
- (Pending - waiting for next test run)

## Key Observations

1. **Insertion appears successful**: No errors thrown, logs show "Successfully inserted X chunks"
2. **Vectors not immediately queryable**: Even with 5-second delay, verification queries find nothing
3. **Metadata filtering not working**: Queries with filters return 0 matches regardless of metadata structure
4. **Similarity search finds other vectors**: When querying without filter, we get GitHub chunks but not our test/Cursor vectors
5. **Vector IDs differ**: Test vectors use IDs like `test-{timestamp}-{idx}`, while similarity search returns hashed IDs like `e247965c46d06d86`

## Hypotheses

1. **Eventual consistency delay**: Vectorize may need much longer than 5 seconds to make vectors searchable
2. **Metadata indexing issue**: Metadata might not be indexed correctly, making filtered queries fail
3. **Vector ID format issue**: Test vector IDs (`test-*`) might not be compatible with Vectorize's internal ID system
4. **Silent insertion failure**: Insert might succeed but vectors aren't actually stored
5. **Embedding similarity issue**: Cursor conversation text might embed differently than GitHub markdown, causing lower similarity scores

## Next Steps

- Check if test vectors appear in topK=100 results (current test running)
- Try querying with much longer delay (30+ seconds)
- Verify if regular Cursor chunks (not test vectors) use the same ID format as GitHub chunks
- Check Vectorize documentation for metadata filtering requirements
- Consider if there's a difference in how embeddings are generated for Cursor vs GitHub content

