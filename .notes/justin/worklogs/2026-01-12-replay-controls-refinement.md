# 2026-01-12-replay-controls-refinement

## Problem

The current moment replay tooling is oriented around whole-run replay with an ascending order cursor. In practice I need to iterate on linking and synthesis behavior, which means I need to:

- replay in descending date order
- replay a selected subset of documents without replaying everything
- recollect a selected subset of documents (regenerate replay items) without recollecting everything

These operations should be available in the audit UI so I can iterate without running worker scripts manually.

## Plan

- Define replay ordering and selection semantics in an architecture note.
- Decide which operations mutate an existing replay run versus creating a separate run for the selected set.
- Define the minimum database shape needed for selecting replay items by document id and time range.
- After the doc is agreed on, implement backend + UI changes.

## Implemented replay ordering and selective operations

I added run-level replay order (ascending or descending) and updated the replay worker fetch logic so it can traverse replay items in descending order using the same (order_ms, item_id) cursor shape.

I added replay item metadata columns (document id, stream id, macro moment index) and updated replay item inserts to upsert so recollect can overwrite existing items in a run.

In the audit UI, I added controls to:

- restart replay in descending order
- replay selected documents (by document id / R2 key list)
- recollect selected documents (enqueue collect jobs with a force flag so chunk diff does not short-circuit)

