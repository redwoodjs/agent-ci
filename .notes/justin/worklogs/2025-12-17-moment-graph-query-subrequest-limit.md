# Moment Graph query failure: "Too many API requests by single worker invocation" (prod-2025-12-16)

## Context
Queries against the `prod-2025-12-16` Moment Graph namespace are failing in the deployed worker. The logs show the narrative query path failing, then a fallback to the Evidence Locker path that is disabled, so the query produces no narrative context.

## Problem
The query handler hits Cloudflare's per-invocation API/subrequest limit ("Too many API requests by single worker invocation") during the narrative retrieval phase.

## Plan
- Extract the log segment around the failing queries and identify which narrative query steps are executed before the failure.
- Map those steps to code paths and count subrequests (Vectorize queries, Durable Object fetches, internal DB queries).
- Reduce the number of per-invocation subrequests by batching reads and/or lowering fanout.
- Re-run query locally and (if possible) validate on the deployed worker.

## Notes

### Observations from deployed logs (/tmp/out.log)
- Both failing queries log:
  - narrative namespace is `prod-2025-12-16`
  - `similarSubjects=0` (after warnings about subject ids missing in the DB)
  - `similarMoments=19`
  - then the narrative path throws `Error: Too many API requests by single worker invocation.`
  - fallback path is disabled (`evidenceLockerDisabled=true`)

The narrative path fails after logging `similarMoments=19`, and before any of the later narrative logs that would appear after resolving a root and building a timeline.

### Initial code mapping
- Query flow is in `src/app/engine/engine.ts` and calls:
  - `findSimilarSubjects` (Vectorize query + DB fetch)
  - `findSimilarMoments` (Vectorize query + DB fetch)
  - `findAncestors(bestMatch.id)`
  - `findDescendants(root.id)`

In `src/app/engine/momentDb/index.ts`:
- `findSimilarSubjects` and `findSimilarMoments` batch DB reads via `getMoments(ids)` (one DB query for <= 100 ids).
- `findAncestors` loops upward one parent pointer at a time and runs one DB query per step, with no cycle detection or max depth cap.
- `findDescendants` uses a recursive walk that runs one DB query per visited parent id (fetch children for each node).

### Hypothesis
The per-invocation API/subrequest limit is likely reached by a high fanout of DB queries in one of:
- an ancestor traversal that never terminates due to a parent cycle (example: a row whose parent id points to itself), or
- descendant traversal that issues one query per node and grows with timeline size.

The lack of cycle detection in ancestor traversal looks like a plausible way to hit the limit quickly without any other logs being emitted.

### Attempt: reduce DO query fanout in narrative traversal
I updated `src/app/engine/momentDb/index.ts` to remove per-node DB queries in narrative traversal:
- `findAncestors` now loads the id-parent map in one query, walks parents in memory with cycle detection and a max depth cap, then batches the full moment fetch.
- `findDescendants` now loads all moments in one query, builds a parent-to-children map in memory, walks the subtree with cycle detection and a max node cap, then returns a list sorted by timestamp.

This is intended to keep the narrative query path under Cloudflare's per-invocation request limit even when the graph is large or contains parent cycles.
