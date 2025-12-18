## Problem
The Smart Linker is still getting empty Vectorize candidate sets (matches: []) in a fresh namespace run, even after a short in-process retry. This blocks cross-document attachments (issue -> PR -> discord/cursor) at indexing time.

I want a quick, low-risk way to rule out index state issues by rotating the Vectorize indexes used by the worker.

## Context
- The worker uses three Vectorize bindings:
  - VECTORIZE_INDEX (rag)
  - SUBJECT_INDEX
  - MOMENT_INDEX
- We rely on Vectorize metadata filtering by momentGraphNamespace.

## Plan
- Create replacement Vectorize indexes (same embedding dimension and metric).
- Update wrangler.jsonc to point VECTORIZE_INDEX, SUBJECT_INDEX, MOMENT_INDEX at the replacement index names.
- Re-run a resync in an isolated namespace and check whether candidate matches appear.

## Actions
- Created Vectorize indexes:
  - rag-index-v3 (binding: VECTORIZE_INDEX)
  - subject-index-v2 (binding: SUBJECT_INDEX)
  - moment-index-v2 (binding: MOMENT_INDEX)
- Updated wrangler.jsonc top-level Vectorize bindings to use these index names.

## Follow-up: metadata indexes for filtering
- The code filters Vectorize queries by momentGraphNamespace (string) in:
  - VECTORIZE_INDEX (rag)
  - SUBJECT_INDEX (smart linker + subject search)
  - MOMENT_INDEX (moment search)
- Created metadata indexes on momentGraphNamespace for:
  - rag-index-v3
  - subject-index-v2
  - moment-index-v2
