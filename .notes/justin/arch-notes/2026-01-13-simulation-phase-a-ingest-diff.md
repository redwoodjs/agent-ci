# Simulation Phase A: ingest and diff (attempt)

## Goal

Phase A is the first phase in the simulation run that touches source data. It establishes a per-run view of:

- which documents are in scope for the run
- a stable identity for each document's current content
- whether each document changed since the last time Phase A ran for this run

This output is used by later phases to avoid recomputation.

## Inputs

Phase A needs an explicit document selection. For the first cut, the run config provides:

- r2Keys: list of R2 keys to process

Later, this can be extended with prefix scans or source-specific selectors, but Phase A should keep the selection mechanism separate from the diff mechanism.

## Output artifacts (persisted in simulation state DB)

Per-run document state table keyed by (run_id, r2_key):

- etag: R2 object etag
- changed: 1 if etag differs from previous stored etag, else 0
- error payload when head/fetch fails
- timestamps

The phase also records aggregate events:

- phase.start with r2KeysCount
- phase.end with counts: succeeded/failed/changed/unchanged

## Semantics

- If Phase A is re-run for the same run_id with the same r2Keys and identical document content, it should record unchanged documents and avoid downstream work.
- If any document fails, the run should move to paused_on_error with last_error_json populated.

## Acceptance checks

- A run can be created with r2Keys.
- Advancing from Phase A processes r2Keys and persists per-document rows.
- Restarting from Phase A and advancing again:
  - produces unchanged documents when the R2 content did not change
  - produces changed documents when the R2 content changed

