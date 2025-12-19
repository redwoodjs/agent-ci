## Problem
Narrative query is currently anchored by the single best vector match, then it walks to that match's root and returns the root timeline.

In namespaces with many short test conversations, these test subjects can dominate because they embed strongly against generic prompts.

I want a fast way to identify which subject trees contain the most high-importance nodes so I can:
- sanity check backfills
- pick a better default root candidate than "top embedding match"

## Decision
Use a sampled stats approach instead of maintaining rollups incrementally.

Compute stats from a bounded sample of moments with importance above a cutoff.

## Plan
- Add a Moment DB helper that:
  - selects up to N moments where importance >= cutoff
  - walks parent links upward by fetching only the needed ancestor rows (batched), not the entire table
  - attributes each sampled moment to a root
  - aggregates per-root counts and sums
- Add an admin endpoint to return these stats for a given namespace.

## Expected output
For each root:
- sampledHighImportanceCount
- sampledImportanceSum
- sampledImportanceMax
- root title + document id

Sort descending by sampledHighImportanceCount then sampledImportanceSum.

## Validation
- Added `/admin/tree-stats` (POST) and exercised it locally against a small namespace prefix.
- The endpoint returns the expected root list and aggregates when the namespace contains high-importance moments.

## Follow-up: use sampled stats in narrative query selection
- I added a query-time heuristic for narrative queries that ranks candidate roots by sampled high-importance counts (computed from a bounded sample), then chooses the best-scoring root among the roots of the top vector matches.
- This is intended to reduce cases where short test roots dominate root selection in large demo namespaces.

## Follow-up: allow GitHub and Discord anchors
- When the top vector matches include a GitHub issue/PR moment, the narrative query anchors on that moment and builds the timeline from it.
- Otherwise, if the top matches include a Discord thread or channel-day moment, the narrative query anchors on that moment.
- This is intended to keep the narrative path from defaulting to a Cursor conversation root when the query is generic.
