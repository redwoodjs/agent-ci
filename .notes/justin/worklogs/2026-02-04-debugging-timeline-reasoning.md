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

## Work Task Blueprint: Fix Timeline Fit Reasoning and UI Visibility

### Context
**The Problem**: Even with Phase 8 running and logging to the backend, the Simulation UI shows "nothing there" and "decisions: (none)" for Timeline Fit.
- **Root Cause 1 (Data Retrieval)**:  in `runArtifacts.ts` was looking for the key `candidates` and the field `momentId`, while the orchestrator returns `decisions` and `candidateId`.
- **Root Cause 2 (Observability)**: LLM veto decisions are not explicitly logged, making it opaque whether the LLM is actually vetoing candidates or even being called.

**The Solution**: Align the data retrieval layer with the core orchestrator and add explicit heartbeat logs for LLM operations.

**Approach**:
1.  Update `getSimulationRunTimelineFitDecisions` to handle the schema returned by the orchestrator.
2.  Add diagnostic logs to the `llmVeto` wrapper for Start, Result, and Fail states.

### Breakdown of Planned Changes

#### Data Retrieval Layer
- **[MODIFY] `src/app/engine/simulation/runArtifacts.ts`**:
    - Update `getSimulationRunTimelineFitDecisions` to map `decisions` -> `detailedDecisions`.
    - Map `candidateId` to the moment details lookup.

#### Timeline Fit Orchestrator
- **[MODIFY] `src/app/pipelines/timeline_fit/engine/core/orchestrator.ts`**:
    - Add `timeline-fit:diagnostic:llm-veto-start`
    - Add `timeline-fit:diagnostic:llm-veto-result`
    - Add `timeline-fit:diagnostic:llm-veto-fail`

### Suggested Verification (Manual)
1.  Rerun a simulation (e.g. `needle-sim-1`).
2.  Inspect the "Timeline Fit" card in the Simulation UI.
3.  Expand "Model Reasoning & Stats" to confirm `decisions` array is populated and contains candidate details.

## Final Review and PR Drafting [2026-02-04]
We have completed the verification of the deterministic linking and timeline fit fixes. The system now correctly handles self-references and surfaces its reasoning in the UI.

### PR Description: Resolving Linking Failures and Enhancing Simulation Observability

#### Problem
During end-to-end simulation testing, we identified several critical failure modes in the linking and fitment phases:
1.  **Self-Linking Loop**: Pull Requests and Issues containing their own ID (e.g., "PR #933") were incorrectly picking themselves as parent candidates in the `deterministic_linking` phase, blocking resolution to legitimate parents.
2.  **Opaque Fit Decisions**: The `timeline_fit` phase was producing decisions, but reasoning and LLM veto outcomes were missing from the UI. This was due to a naming mismatch in the data retrieval layer and a lack of heartbeats for internal model operations.
3.  **Namespace Double-Prefixing**: Simulation data was occasionally invisible in the Knowledge Graph due to the prefix being applied twice when generating links.

#### Solution
This change hardens the simulation pipeline and ensures vertical visibility of all model-backed decisions.

1.  **Hardened Deterministic Linking**:
    - Replaced the single-match regex with a global scan to identify all potential parent candidates in the raw document.
    - Implemented explicit self-reference filtering by parsing the source document's ID before scanning.
2.  **Synchronized Fit Retrieval**:
    - Unified the naming conventions between the orchestrator and the `runArtifacts.ts` retrieval layer (`decisions` and `candidateId`).
    - Routed diagnostic logs through the `PipelineContext.logger` for persistent backend visibility.
3.  **Verifiable LLM Operations**:
    - Added explicit heartbeats for the `llmVeto` wrapper, ensuring that every model decision is traceable in the simulation event stream.
4.  **Namespace Parity**: Improved the routing from Simulation Runs to the Knowledge Graph to prevent double-prefixing and respect intentional project isolation.

#### Verification
- **PR #933 Result**: Confirmed that the self-reference is skipped and the link resolves correctly to Issue #552.
- **UI Surface**: Verified that the "Model Reasoning & Stats" section in the Simulation UI is now fully populated with candidate evaluations and LLM veto notes.
- **Knowledge Graph**: Navigating from a simulation run now correctly resolution to the filtered project view.
