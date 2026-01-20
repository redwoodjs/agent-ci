# 2026-01-20-async-r2-listing

## Implemented Async R2 Listing

I addressed the timeout issue during the initial backfill bootstrapping by moving the synchronous R2 key listing logic into a dedicated, asynchronous, and checkpointable simulation phase.

### Problem
The `runAllSimulationRunAction` attempted to list *all* R2 keys synchronously before starting the simulation. For large buckets (tens of thousands of keys), this operation exceeded the Cloudflare Workers 30s execution limit, causing the backfill to fail immediately.

### Solution
I introduced a new simulation phase, `r2_listing`, which runs before `ingest_diff` and incrementally discovers keys.

1.  **New Phase: `r2_listing`**:
    - Created `src/app/pipelines/r2_listing/engine/simulation/runner.ts`.
    - This runner reads `config.r2List`, fetches a single page of keys (default 200), and inserts them into `simulation_run_documents` with `processed_at: "pending"`.
    - It maintains state (`cursor`, `currentPrefixIdx`) in `simulation_runs.config_json` to support restartability and continuation across multiple ticks.
    - It yields `status: "running"` until all prefixes are fully exhausted.

2.  **Updated `runAllSimulationRunAction`**:
    - Removed the synchronous `listR2KeysHelper`.
    - Function now initializes the simulation immediatley with the `r2_listing` phase and the necessary scan configuration (prefixes, limits) in `config_json`.
    - This returns instantly to the UI, allowing the simulation loop to handle the heavy listing work.

3.  **Adapted `ingest_diff`**:
    - Modified to support a "Database-driven" mode.
    - Previously, it relied on `config.r2Keys` being a complete list of work.
    - Now, if `config.r2Keys` is empty, it queries the `simulation_run_documents` table for pending items (items not yet dispatched to `ingest_diff`).
    - Implemented batching (limit 1000 fetch, 250 dispatch) to prevent OOMs or timeouts when processing the large number of keys discovered by `r2_listing`.

### Outcome
Backfills can now scale to arbitrary bucket sizes without hitting the initial request timeout. The discovery process is fully observable as a simulation phase.
