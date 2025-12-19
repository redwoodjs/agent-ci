## Problem

I want a clean slate in production:

- fresh Vectorize indexes
- fresh Moment Graph / Subject Graph durable object databases
- a single production namespace prefix configured on the worker
- stop passing namespace/prefix overrides in admin backfill/resync calls

## Context

- Vectorize indexes are configured in wrangler bindings.
- Engine durable object databases are keyed by a durable object id string.
- Engine durable object id selection is based on the effective moment graph namespace, which can include a prefix.

## Plan

- Confirm how the engine durable object ids are constructed.
- Rotate Vectorize index names in wrangler.
- Provide wrangler commands to create the indexes and metadata indexes.
- Set production env vars so the worker has a default base namespace + prefix.

## Work log

### 2025-12-19

- Started verifying that Moment Graph DO, Subject DO, and Engine Indexing State DO ids are derived from the effective moment graph namespace.
- Preparing a Vectorize index rotation so production can start indexing into empty indexes.
- Rotated wrangler Vectorize bindings to:
  - rag-index-v4
  - moment-index-v4
  - subject-index-v4
- Created the Vectorize indexes and queued metadata index creation for `momentGraphNamespace` on both moment and subject indexes.
- Set production `MOMENT_GRAPH_NAMESPACE` to `redwood:rwsdk` so the worker has a default base namespace (so prefixing works without per-request overrides).

- Follow-up: rotating again for a clean slate iteration.
  - Rotated production Vectorize bindings to:
    - rag-index-v5
    - moment-index-v5
    - subject-index-v5
  - Updated production `MOMENT_GRAPH_NAMESPACE_PREFIX` to `prod-2025-12-19-16-01`.
  - Plan: purge production queues to avoid old backlog processing under the rotated prefix.
