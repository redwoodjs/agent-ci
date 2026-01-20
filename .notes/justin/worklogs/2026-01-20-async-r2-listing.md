# 2026-01-20-async-r2-listing

## Implemented Async R2 Listing

I addressed the timeout issue during the initial backfill bootstrapping by moving the synchronous R2 key listing logic into a dedicated, asynchronous, and checkpointable simulation phase.

### Problem
The `runAllSimulationRunAction` attempted to list *all* R2 keys synchronously before starting the simulation. For large buckets (tens of thousands of keys), this operation exceeded the Cloudflare Workers 30s execution limit, causing the backfill to fail immediately.

Initially, I implemented a row-per-key insertion strategy in the `r2_listing` phase, but this hit SQLite variable limits (`too many SQL variables`) when batching inserts for large pages.

Then, I encountered a `SyntaxError: Unexpected token 'g'...` in the `ingest_diff` phase because I was manually `JSON.parse`-ing columns that `rwsdk` had already auto-parsed.

### Solution
I introduced a new simulation phase, `r2_listing`, which runs before `ingest_diff` and incrementally discovers keys. I also switched to a JSON blob storage strategy to avoid database bottlenecks.

1.  **New Table: `simulation_run_r2_batches`**:
    - Stores pages of R2 keys as compressed JSON blobs rather than individual rows.
    - Columns: `run_id`, `batch_index`, `keys_json`, `processed`.
    - **Note**: `rwsdk` automatically parses JSON columns on read, so the runner must treat them as objects/arrays immediately.

2.  **New Phase: `r2_listing`**:
    - Created `src/app/pipelines/r2_listing/engine/simulation/runner.ts`.
    - This runner reads `config.r2List`, fetches a page of keys (default 1000), and inserts them as a SINGLE row into `simulation_run_r2_batches`.
    - It uses `JSON.stringify` on write (required).

3.  **Updated `ingest_diff`**:
    - Modified to consume from `simulation_run_r2_batches`.
    - It picks up a pending batch, expands the JSON keys (auto-parsed on read), and *then* robustly inserts them into `simulation_run_documents` (in safe chunks of 50) while dispatching them to the queue.
    - Fixed `JSON.parse` double-parsing bug.

### Outcome
Backfills can now scale to arbitrary bucket sizes. The discovery process is fast (bulk blobs) and the ingestion process is safely throttled and batched.
