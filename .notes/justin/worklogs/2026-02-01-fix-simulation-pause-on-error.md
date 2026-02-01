# Fix Simulation Pause on Error 2026-02-01

## Investigated simulation pause on error
We investigated a production issue where the simulation would pause on error (`paused_on_error`) instead of retrying or skipping, despite previous efforts to make it resilient.

### Findings
1.  **JSON Crash**: The immediate cause of the failure was a `TypeError: y.filter is not a function` in `recoverZombiesForPhase` (and other runners). This happens because `dispatched_phases_json` is returned as a JSON string from the DB driver, but the code treats it as an array without parsing.
2.  **Aggressive Skipping**: The host runner (`runner.ts`) was configured to *skip* to the next phase upon error if `continueOnError` was set. This caused the run to "crash through" all phases sequentially until it reached the last one (`timeline_fit`), where it had nowhere to skip to, resulting in `paused_on_error`.
3.  **Regression**: This "Skip" behavior contradicted the intent of a previous worklog (2026-01-28), which stated the runner should *retry* the current phase.

## Decided to implement Infra-Native retry
To align with the "Errors do not block" invariant and ensure Cloudflare Worker budget is preserved:
1.  **Fix the Crash**: We will safely parse JSON columns in `resiliency.ts`.
2.  **Fix the Logic**: We will modify `runner.ts` to *retry* the current phase (instead of skipping) when `continueOnError` is true.
3.  **Leverage Infra**: Instead of manual `setTimeout` or "Magic Enqueues", we will **rethrow** the error to trigger Cloudflare's native `message.retry()`.
4.  **DLQ Guard**: We will configure a Dead Letter Queue (DLQ) to prevent infinite loops on permanent errors.

## Work Task Blueprint: Infra-Native Simulation Resiliency

### 1. Context
The simulation currently fails to recover from host-level errors because it attempts to skip phases rather than retrying them. We will shift to an infra-native approach using Cloudflare Queue retries, which provides exponential backoff and DLQ support without manual over-engineering.

### 2. Breakdown of Planned Changes

#### Configuration
*   [MODIFY] `wrangler.jsonc`:
    *   Add `max_retries: 3` and `dead_letter_queue` to `engine-indexing-queue-prod`.
    *   Add the same for `engine-indexing-queue-dev-justin` and `engine-indexing-queue-rag-experiment-1`.

#### Core Engine
*   [MODIFY] `src/app/engine/simulation/resiliency.ts`:
    *   Implement/Use `safeJson` helper to handle double-encoded JSON strings from legacy data.
*   [MODIFY] `src/app/engine/runners/simulation/runner.ts`:
    *   In `tickSimulationRun` catch block:
        *   Remove `nextPhase` logic.
        *   Update DB: set status to `running`, log `last_error_json` with `recovered: true`.
        *   **Throw/Rethrow** an Error to trigger infra retry.
    *   In `autoAdvanceSimulationRun`:
        *   Ensure it does NOT attempt to loop or wait on error; the throw will terminate the worker tick.

#### Pipelines
*   [MODIFY] `src/app/pipelines/ingest_diff/engine/simulation/runner.ts`:
    *   Remove manual `JSON.stringify([])` to rely on DB driver auto-serialization.

### 3. Directory & File Structure
```text
wrangler.jsonc
src/app/engine/
├── runners/simulation/
│   └── [MODIFY] runner.ts
└── simulation/
    └── [MODIFY] resiliency.ts
src/app/pipelines/ingest_diff/engine/simulation/
└── [MODIFY] runner.ts
```

### 4. Invariants & Constraints
-   **Invariant**: Host-level crashes MUST trigger native `message.retry()` for exponential backoff.
-   **Invariant**: Repeated failures (3+) MUST fall into a DLQ for observability.
-   **Invariant**: The DB state MUST remain consistent (`status: running`) before rethrowing.

### 5. System Flow (Snapshot Diff)
**Previous Flow**: Crash -> Catch -> Log -> Skip Phase -> Continue.
**New Flow**: Crash -> Catch -> Update DB -> Rethrow -> Infra Retry (Exponential Backoff) -> Success or DLQ.

### 6. Suggested Verification (Manual)
1.  **Induce Failure**: Temporarily throw inside `onTick`.
2.  **Verify Retry**: Confirm Cloudflare logs show message retries.
3.  **Verify DLQ**: Intentionally reach 3 failures and verify DLQ entry.

## Investigated JSON inconsistency
We found that `ingest_diff` was explicitly calling `JSON.stringify([])`. Mixed types in the database caused the `y.filter` crash. This is addressed by standardizing on driver auto-serialization.

## Final Implementation: Infra-Native Resiliency
1.  **Queue Configuration**: Updated `wrangler.jsonc` with DLQs and `max_retries: 3`.
2.  **Host Runner**: Modified `runner.ts` to `throw` on phase crash. This utilizes Cloudflare's native retry budget and backoff curves.
3.  **Defensive Parsing**: Implemented `safeJson` in `resiliency.ts`.
4.  **Blueprints**: Updated `docs/blueprints/simulation-engine.md`.

## Bedrock Step 9: Final Review
- [x] Invariant "Errors Trigger Retry": Satisfied via native Queue retries.
- [x] Invariant "Strict JSON Parsing": Satisfied via `safeJson` and `ingest_diff` removal.
- [x] Blueprints updated.

## Bedrock Step 10: Draft PR
**Title**: Simulation Resiliency: Infra-Native Retries and JSON Consistency
**Narrative**: This PR replaces a brittle manual retry mechanism with native Cloudflare Queue retries and DLQs. It also fixes a critical type error crash caused by inconsistent JSON serialization between different runners.
**Rationale**: By leveraging infrastructure-native retries, we ensure simulations are robust against transient failures while respecting Cloudflare Worker execution limits. Standardizing JSON serialization prevents runtime crashes on state recovery.
