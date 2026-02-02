# Investigating Runner-Level Retry Logic [2026-02-02]

## Context: Lessons from a Failed Strategy
We previously attempted to fix "Simulation Thrashing" (infinite retries of failing documents) by implementing ad-hoc "Give Up" logic (max retries) in every single simulation phase runner (`micro_batches`, `timeline_fit`, etc.).

**Mistakes made:**
1.  **Violation of DRY**: We duplicated `retry_count` logic across multiple files (`micro_batches`, `ingest_diff`, etc.).
2.  **Ignored Architecture**: We bypassed the existing centralized Orchestrator/Runner infrastructure which typically handles error boundaries and retry policies. The user pointed out that failures should be caught and handled at the "runner level", not implemented per-phase.
3.  **Fragility**: Logic scattered across specific implementations is harder to maintain and audit.

## Problem Statement
The simulation enters a "thrashing" state where a specific document fails repeatedly (e.g., LLM error in a micro-batch). The Orchestrator `onTick` sees it as "not processed" and re-dispatches it indefinitely.

We need to implement the "Give Up" (Max Retry) logic at the **Infrastructure Level** (the generic Orchestrator or Worker wrapper) so that ALL phases inherit this behavior automatically without code duplication.

## Files of Interest (for Investigation)
- `src/app/engine/simulation/orchestration.ts`: The generic `onTick` logic (likely where dispatch decisions—and checks for retry counts—should live centrally).
- `src/app/engine/services/simulation-worker.ts`: The worker entry point that executes jobs.
- `src/app/engine/simulation/types.ts`: Where the database schema types live.
- `src/app/engine/simulation/migrations.ts`: We will still likely need the migration for `retry_count`.

## Next Steps (Bedrock Protocol)
1.  **Investigation**: Analyze `orchestration.ts` and `simulation-worker.ts` to find the proper "high-level" place to hook in the retry/give-up logic.
2.  **Draft Plan**: Create a new Work Task Blueprint that modifies ONLY the infrastructure files, removing the need for per-phase changes.
# Work Task Blueprint: Application-Level Orchestration & Unified Retry Logic

## 1. Context
**Problem**: 
1.  **Infinite Retries (Thrashing)**: When a document fails processing (e.g., LLM error), the current orchestration logic repeatedly re-dispatches it forever because it lacks a "Max Retry" or "Give Up" mechanism.
2.  **Boilerplate & Risk**: Every simulation phase manually implements its own `onTick` polling logic. This not only causes code duplication but has led to inconsistencies where some phases (like `micro_batches`) implement custom polling that bypasses standard safety checks.
3.  **Missing `retry_count`**: The database schema lacks a counter to track application-level retries.

**Solution**: 
Shift from an **Imperative** (Callback) model to a **Declarative** model.
1.  **Declarative Registry**: Phases will declare their `inputs` (e.g., `['document']`), removing the need for `onTick`.
2.  **Central Orchestrator**: The Supervisor (`runner.ts`) will implement a single, robust polling loop that handles Cooldowns, Dispatching, and crucially, **Retry Limits**.
3.  **Unified Retry Logic**: A document that fails 3 times (application error) will be marked as "skipped" so the simulation can progress. This complements our existing Infra-Level DLQs which handle worker crashes.

**Design Decisions**:
*   **Schema**: Add `retry_count` to `simulation_run_documents` and `simulation_run_micro_batches`.
*   **Backward Compatibility**: Keep `onTick` in the type definition but mark it optional, allowing complex phases (if any) to retain custom logic.
*   **Implicit vs Explicit**: We prefer implicit orchestration. If a phase says it needs 'documents', the engine ensures it gets them, safely.

## 2. Breakdown of Planned Changes

### Database Schema
*   [MODIFY] `src/app/engine/simulation/migrations.ts`:
    *   Add `retry_count` column (integer, default 0) to `simulation_run_documents`.
    *   Add `retry_count` column (integer, default 0) to `simulation_run_micro_batches`.

### Core Engine Types
*   [MODIFY] `src/app/engine/simulation/registry.ts`:
    *   Update `PipelineRegistryEntry`:
        *   Add `inputs: ('document' | 'batch' | 'custom')[]`.
        *   Make `onTick` optional.

### Supervisor & Orchestration
*   [MODIFY] `src/app/engine/simulation/orchestration.ts`:
    *   Refactor `runStandardDocumentPolling` into a generic `pollAndDispatch` function.
    *   **Implement "Give Up" Logic**:
        *   If `retry_count >= MAX_RETRIES` (e.g., 3), mark the document/batch as "processed" (add phase to `processed_phases_json`) and log a "Skipped" event. Do NOT dispatch it.
*   [MODIFY] `src/app/engine/runners/simulation/runner.ts`:
    *   Update `tickSimulationRun` to read `inputs` from the registry entry.
    *   If `inputs` contains 'document', call `orchestrator.pollDocuments`.
    *   If `inputs` contains 'batch', call `orchestrator.pollBatches`.

### Phase Refactoring (Cleanup)
*   [MODIFY] `src/app/pipelines/**/runner.ts` (All Phases):
    *   Remove `onTick` implementation.
    *   Add `inputs: ['document']` (or `['document', 'batch']` for `micro_batches`).
    *   Specific impact on `micro_batches`: Remove its custom polling logic and rely on the new central `pollBatches`.

## 3. Directory & File Structure
```text
src/app/engine/simulation/
├── [MODIFY] migrations.ts
├── [MODIFY] registry.ts
├── [MODIFY] orchestration.ts
├── [MODIFY] types.ts
src/app/engine/runners/simulation/
└── [MODIFY] runner.ts
src/app/pipelines/
├── micro_batches/engine/simulation/[MODIFY] runner.ts
├── ingest_diff/engine/simulation/[MODIFY] runner.ts
├── timeline_fit/engine/simulation/[MODIFY] runner.ts
└── ... (other phases)
```

## 4. Types & Data Structures
```typescript
// Updated Registry Entry
export type PipelineRegistryEntry = {
  phase: SimulationPhase;
  label: string;
  inputs: ('document' | 'batch' | 'custom')[];
  onTick?: (context: SimulationDbContext, input: ...) => Promise<...>; // Now Optional
  // ...
};

// Orchestrator Logic
export type PollingOptions = {
    maxRetries: number; // Default 3
    cooldownMs: number; // Default 10m (30s dev)
}
```

## 5. Invariants & Constraints
*   **Invariant**: A document MUST NOT be dispatched if it has failed `MAX_RETRIES` times.
*   **Invariant**: The "Infrastructure DLQ" handles crashes; the "Application Retry" handles business failures (errors returned by the handler without crashing).
*   **Constraint**: `micro_batches` is the only phase currently using 'batch' inputs. The system must support mixed input types in the registry array.

## 6. System Flow (Snapshot Diff)
**Previous Flow**:
Supervisor -> Phase.onTick() -> Phase manually polls DB -> Checks Cooldown -> Despairs at lack of Retry Count -> Dispatches Forever.

**New Flow**:
Supervisor -> Check Phase.inputs ->
   -> Call `orchestrator.pollDocuments`
      -> **Check `retry_count < 3`** -> Dispatch.
      -> **Check `retry_count >= 3`** -> Mark "Skipped" -> Log Warning.

## 7. Suggested Verification (Manual)
1.  **Migration**: Run `wrangler d1 migrations apply` locally.
2.  **Retries**: Manually set a document's `retry_count` to 2 and trigger a failure. Verify it is retried once more, then marked skipped.
3.  **Batch Processing**: Verify `micro_batches` still processes generic documents AND specific batches correctly using the new declarative inputs.

## 8. Tasks
- [ ] Add `retry_count` migration.
- [ ] Update `PipelineRegistryEntry` type.
- [ ] Implement central `pollDocuments` and `pollBatches` in `orchestration.ts` with "Give Up" logic.
- [ ] Update Supervisor `runner.ts` to use declarative inputs.
- [ ] Refactor all phase runners to remove `onTick`.
