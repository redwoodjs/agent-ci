# 2026-01-20-async-r2-listing

## Implemented Async R2 Listing

I addressed the timeout issue during the initial backfill bootstrapping by moving the synchronous R2 key listing logic into a dedicated, asynchronous, and checkpointable simulation phase.

### Problem
The `runAllSimulationRunAction` attempted to list *all* R2 keys synchronously before starting the simulation. For large buckets (tens of thousands of keys), this operation exceeded the Cloudflare Workers 30s execution limit, causing the backfill to fail immediately.

Initially, I implemented a row-per-key insertion strategy in the `r2_listing` phase, but this hit SQLite variable limits (`too many SQL variables`) when batching inserts for large pages.

Then, I encountered a `SyntaxError: Unexpected token 'g'...` in the `ingest_diff` phase because I was manually `JSON.parse`-ing columns that `rwsdk` had already auto-parsed.

Finally, even with batched JSON storage, the `ingest_diff` host runner hit variable limits when expanding the batches back into rows (inserting 50 at a time).

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
    - **Distributed Insert Strategy**:
    - Host runner consumes `simulation_run_r2_batches`, expands the keys, and **ONLY** dispatches messages to the queue. It performs **ZERO** document checks or inserts, completely avoiding SQL variable limits.
    - Worker runner receives the key, performs the logic, and effectively handles the "Create or update" (UPSERT) of the document row in `simulation_run_documents`.
    - Completion is tracked by `COUNT(simulation_run_documents) == Total Keys in Batches`.

### Outcome
Backfills can now scale to arbitrary bucket sizes. The discovery process is fast (bulk blobs) and the ingestion process is safely throttled, with write pressure distributed across workers.
