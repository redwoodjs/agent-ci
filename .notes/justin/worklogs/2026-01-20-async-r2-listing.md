# 2026-01-20-async-r2-listing

## Solved: Simulation Backfill Timeouts

This worklog documents the complete re-architecture of the simulation bootstrapping process to support production-scale backfills (100k+ keys) without hitting serverless timeouts or database limits.

### 1. The Core Problem: Synchronous Bootstrapping
Previously, the `runAllSimulationRunAction` server action attempted to list **all** R2 keys synchronously before starting the simulation.
-   **Impact**: For buckets with >10,000 keys, this operation consistently exceeded the Cloudflare Workers 30s execution limit.
-   **Result**: Backfills failed immediately upon trigger.

### 2. Architecture Evolution

#### Phase 1: Async R2 Listing (The "New Phase")
We moved the listing logic out of the server action and into a dedicated simulation phase (`r2_listing`).
-   **Change**: A new `r2_listing` phase was added as the first step of the pipeline.
-   **Mechanism**: The runner incrementally pages through the R2 bucket, checkpointing its cursor in `simulation_runs.config_json` after every page. This allows the discovery process to span multiple execution ticks.

#### Phase 2: JSON Batch Storage (Solving Variable Limits)
Initial implementation attempted to insert discovered keys as individual rows (`simulation_run_documents`) in the `r2_listing` phase.
-   **Issue**: Bulk inserting 1,000 rows (even in chunks) caused `SQLITE_ERROR: too many SQL variables` due to the high cardinality of columns per row.
-   **Fix**: Introduced a new table `simulation_run_r2_batches`.
-   **Mechanism**: The `r2_listing` runner now stores entire pages of keys as compressed JSON blobs (1 row per page). This eliminated the discovery-time database bottleneck.

#### Phase 3: Distributed Insertion (The "Fan-Out" Fix)
The `ingest_diff` phase was updated to consume these JSON blobs. However, the host runner *still* crashed when trying to "hydrate" a batch into 1,000 rows for insertion.
-   **Issue**: The host runner cannot efficienty insert 1,000 rows due to the same variable limits.
-   **Fix**: Implemented a **Distributed Insert Strategy**.
    -   **Host Runner**: Expands the JSON batch and dispatches messages to the work queue.
        -   **Optimization**: Switched to `queue.sendBatch` (100 messages/call) to avoid timeouts from serial network calls.
    -   **Worker Runner**: Receives a single key message and processes the `UPSERT` on the `simulation_run_documents` table.
-   **Outcome**: The high-volume write load is distributed across thousands of parallel workers.

### 3. Cleanup
We removed legacy code that supported manual key lists to simplify the runner logic, as all large-scale testing now uses the async listing path.

### Summary
Backfills are now fully asynchronous from the first click.
1.  **Trigger**: UI creates run record and returns instantly.
2.  **Discovery**: `r2_listing` pages through bucket, storing compressed blobs.
3.  **Ingestion**: `ingest_diff` uses `sendBatch` to rapidly fan out blobs to queue.
4.  **Processing**: Workers upsert rows and process content.
