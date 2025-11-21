# 2025-11-21: Local DO + Remote Resources Analysis

## Problem
We need to understand the implications of running the system with **Local Durable Objects** but **Remote R2 and Vectorize** resources ("Split Brain" setup). Specifically, we need to identify risks where local state might conflict with or pollute the production remote state.

## Analysis of Components

### 1. Ingestion (GitHub, Discord, Cursor) -> Safe
The ingestion systems (`GitHubRepoDO`, `CursorEventsDO`, Backfill DOs) are generally safe in this hybrid mode because **R2 is the source of truth**, not the local SQLite database.

*   **GitHub/Discord Ingestion:**
    *   The processors fetch the latest data from the external API (GitHub/Discord).
    *   They fetch the *current* state from **Remote R2** (the `latest.json`).
    *   They calculate diffs based on Remote R2 vs External API.
    *   The Local DO is used primarily for metadata/locking or local state that mirrors R2.
    *   **Result:** Local execution correctly updates Remote R2. The system is designed to be idempotent and R2-centric.

*   **Cursor Ingestion:**
    *   The Local DO aggregates *local* editor events.
    *   It flushes these unique events (keyed by `generation_id`) to Remote R2.
    *   **Result:** Safe and desired. It acts as a "write-only" buffer from local to remote.

*   **Backfill DOs (State Management):**
    *   These DOs manage cursor state for backfill jobs.
    *   Running locally means the local environment manages the job progress.
    *   **Result:** Safe. Worst case is a redundant backfill if local and prod trigger simultaneously, but since processors are idempotent, no data corruption occurs.

### 2. GitHub Repo Race Conditions ("Last Write Wins")
When both Local and Production environments process events for the same entity (e.g., Issue #123) simultaneously:
*   **Scenario:** Both fetch the entity from GitHub API. Both read `latest.json` from R2. Both write back to R2.
*   **Risk:** Standard concurrency race conditions.
    *   If GitHub state changes between the two fetches (rare but possible during rapid edits), the instance that writes *last* determines the final state in R2.
    *   **Impact:** Low. If "stale" data overwrites "fresh" data, it persists only until the next event/webhook triggers another update. History diffs might be slightly disordered but valid.

### 3. RAG Engine Indexing (`EngineIndexingStateDO`) -> CRITICAL RISK
This is the dangerous component in the "Split Brain" setup.

*   **The Mechanism:**
    *   The system needs to delete *old* vectors for a document before inserting *new* ones to avoid duplicates (index pollution).
    *   Currently, the **Vector IDs** to be deleted are stored in the `EngineIndexingStateDO` (SQLite).
*   **The Failure Mode:**
    1.  **Production** indexes a file, stores Vector IDs `[A, B]` in its **Remote DO**.
    2.  **Local** (with empty Local DO) processes the same file.
    3.  Local checks its DO, finds **no Vector IDs**.
    4.  Local **skips deletion** (believing it's a new file).
    5.  Local generates new vectors `[C, D]` and inserts them into **Remote Vectorize**.
*   **Result:** **Index Pollution.** The remote index now contains `[A, B, C, D]` for the same document. Search results will be duplicated or conflicting.

## Decision: Implement Architecture Fix (Stateless Deletion)

We have decided to implement **Option B: Query-Based Deletion (Stateless)**.

### Rationale
1.  **Correctness First**: Relying on local state (`EngineIndexingStateDO`) to manage a shared remote resource (Vectorize) creates a critical point of failure. If the local state is out of sync (which is guaranteed in a split-brain setup), we corrupt the shared index.
2.  **Eliminate Single Point of Failure**: The system should be robust enough to handle indexing from *any* environment (Local, Prod, Test) without needing to synchronize a hidden side-channel state database first.
3.  **Performance Trade-off**:
    *   *Before*: We rejected this because we were doing bulk backfills (scanning 1000s of files). The latency of `Query -> Delete` per file was too high.
    *   *Now*: We have moved to an **Event-Driven Architecture**. We process files one at a time as they change in R2. The overhead of one extra Vectorize query per file update is negligible compared to the robustness it gains us.
    *   *Future*: If performance becomes a bottleneck during massive re-indexes, we can introduce a caching layer later. For now, correctness is the priority.

## Durable Object Analysis: Local vs. Remote

A detailed breakdown of why each Durable Object is (or isn't) safe to run in a "Split Brain" (Local Worker + Remote Resources) configuration.

### 1. `EngineIndexingStateDO` (The Problem Child)
*   **Role:** Tracks which files have been indexed and stores their Vector IDs for deletion.
*   **Split-Brain Status:** **UNSAFE** (without the fix).
*   **Why:** It holds the *only* map of "What vectors belong to this file?" If Local doesn't have this map, it can't clean up old vectors, leading to index pollution.
*   **Fix:** We are removing the dependency on this DO for the critical "delete vectors" step. It will remain as an optimization/cache for etag tracking, but not as the source of truth for deletion.

### 2. `GitHubRepoDurableObject`
*   **Role:** Manages local state for GitHub entities but primarily coordinates writes to R2.
*   **Split-Brain Status:** **SAFE**.
*   **Why:**
    *   It treats **Remote R2** as the source of truth.
    *   Before writing, it fetches the current `latest.json` from R2.
    *   It diffs the incoming API data against the R2 data.
    *   **Race Condition:** "Last Write Wins". If Local and Prod process the same issue simultaneously, they both fetch from R2, both calculate diffs, and whoever writes last updates R2. This is standard eventual consistency and does not corrupt the history or structure.

### 3. `CursorEventsDurableObject`
*   **Role:** Aggregates high-frequency editor events locally before flushing to R2.
*   **Split-Brain Status:** **SAFE**.
*   **Why:**
    *   It is designed to buffer *local* activity.
    *   It writes to R2 using a unique key (`generation_id`) for each session.
    *   It effectively acts as a "write-only" pipe from your local IDE to the shared memory. It never reads/overwrites shared state in a dangerous way.

### 4. `GitHubBackfillStateDO` & `DiscordBackfillStateDO`
*   **Role:** Manages the progress (cursors) of large backfill jobs.
*   **Split-Brain Status:** **SAFE**.
*   **Why:**
    *   These DOs are just job managers.
    *   If you run a backfill locally, the Local DO manages the cursors.
    *   The worst-case scenario is that Prod has no record of this backfill running.
    *   Since the *processors* (the things doing the work) are idempotent (checking R2 first), running a backfill locally doesn't duplicate data or break anything. It just uses local CPU to drive the job.

---

## RE: Durable Objects Locally vs Production: TLDR

*   **Ingestor DOs (GitHub, Discord)**: **Safe.** They treat R2 as the source of truth. Worst case is "last write wins," which is just eventual consistency.
*   **Cursor DO**: **Safe.** It's a one-way pipe from your local editor to R2. It doesn't overwrite shared state.
*   **Backfill DOs**: **Safe.** They just manage local job progress. Processors are idempotent, so running a job locally doesn't break anything.
*   **Indexing DO**: **Was Unsafe, Now Safe.** It used to hold the "delete keys" for vectors. We fixed it by making the deletion logic stateless (querying Vectorize directly). Now it's just a harmless cache.
