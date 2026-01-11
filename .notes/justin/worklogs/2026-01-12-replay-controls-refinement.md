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

## Default namespace prefix for replay run listing

The Knowledge Graph UI was only listing replay runs when a namespace prefix was explicitly provided to the replay progress action.

I changed the replay progress action to fall back to the configured namespace prefix from the worker environment when no prefix is provided, so the default setup works without typing it into the UI.

## Default namespace for audit views

The ingestion file detail page uses the worker environment variables when `namespace` and `prefix` are not present in the URL query. The prod config had a namespace prefix but not a default base namespace, so direct links to ingestion file pages would not show document audit logs unless the namespace was provided in the URL.

I set the default base namespace in `wrangler.jsonc` so direct ingestion file links resolve the same effective namespace without needing the list page to provide query params.

## Fixed replay progress default prefix in the UI

The Knowledge Graph page was skipping the replay progress fetch unless a prefix was filled in client-side.

I changed it to always call the replay progress action and pass null when the prefix input is empty, so the server-side env prefix fallback is used.

## Fixed selective replay UI controls for completed runs

Selective replay can intentionally leave a run in a completed state. The UI was hiding the replay controls when status was completed, which made it harder to recover a run by recollecting and replaying a small set of documents.

I changed the Knowledge Graph page to always show the run controls when a run id is present, and only disable the Resume button when the run is completed.
