# Debugging Timeline Reasoning [2026-02-04]

## Investigating missing decision logic in Timeline Fit
We observed that the `timeline_fit` phase was running but not producing visible reasoning in the UI. The decisions were being logged to `console.log` which does not surface in the simulation inspection view.

## Work Task Blueprint: Fix Timeline Fit Visibility

### Context
**The Problem**: The `timeline_fit` phase logic computes decisions but logs them via `console.log`. These logs are captured by the runtime logger in some environments but are failing to surface in the Simulation UI's event stream, making it impossible to debug why certain fits are rejected or selected.

**The Solution**: We must route these diagnostics through the `PipelineContext.logger`, which ensures they are captured as structural events in the `simulation_run_logs` (or equivalent) and streamed to the UI.

**Approach**:
1.  Pass the `logger` from `PipelineContext` down into the core orchestrator functions.
2.  Replace critical `console.log` statements with `logger.info`.

### Breakdown of Planned Changes

#### Timeline Fit Debugging
*   **[MODIFY] `src/app/pipelines/timeline_fit/engine/core/orchestrator.ts`**:
    *   Replace `console.log` with `logger.info`.
    *   Pass `logger` down from `runTimelineFitForDocument` to `computeTimelineFitProposalDeep`.
*   **[MODIFY] `src/app/pipelines/timeline_fit/index.ts`**:
    *   Ensure `context.logger` is available and functioning.
    *   (Already verified) `PipelineContext` has `logger` from `IndexingHookContext`.

### Directory & File Structure
```text
src/app/pipelines/timeline_fit/
├── index.ts
└── engine/core/
    └── [MODIFY] orchestrator.ts
```

## Implemented logging fixes
We replaced console.log with logger.info in the timeline_fit orchestrator to ensure decision logic is visible in the simulation UI.
