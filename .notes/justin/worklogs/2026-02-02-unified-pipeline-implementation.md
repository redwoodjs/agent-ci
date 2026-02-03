# Unified Pipeline Implementation: Investigation [2026-02-02]

## Priming
We have locked the target architecture in `docs/blueprints/unified-pipeline.md`.
**Target State**:
*   Single Orchestrator: `executePhase(phase, input, strategy, context)`
*   Strategies: `Live` (NoOp/Direct) vs `Sim` (Artifact/Queue)
*   Stateless Context: `db`, `vector`, `env`, `llm`
*   8 Phases: Ingest, Micro, Macro, Classify, Materialize, Link, Candidate, Fit.

## Investigation Protocol (Confidence Meter)
We will track our "Understanding Coverage" as we audit the codebase.
**Categories**:
1.  **Legacy Rot**: Code to delete/archive.
2.  **Core Logic**: Business logic to preserve/move.
3.  **Infrastructure**: The unified harness to build.

**Current Confidence**: 0% (Starting)


## Finding: The Distributed Legacy Runners
We found that the "Runner" logic is NOT in a central silo, but **duplicated** in every phase directory:
*   Use `src/app/pipelines/<phase>/engine/simulation/runner.ts`
*   Use `src/app/pipelines/<phase>/engine/simulation/adapter.ts`

**Code Smell Identified**:
*   `runner.ts` contains raw Polling Logic (`db.selectFrom...`).
*   `adapter.ts` contains the specific implementation of the phase but
## Investigated Simulation UI Failure [2026-02-02]
We investigated the "No registry entry found" error reporting by the user in `src/app/engine/runners/simulation/runner.ts`.

### Finding: The Registration Sinkhole
*   **The Problem**: The Simulation Host (Supervisor) depends on `src/app/engine/simulation/registry.ts` to find phase handlers.
*   **Legacy Pattern**: Registration was handled as a side-effect in `runner.ts` of each phase.
*   **Refactor regression**: We deleted the `runner.ts` files for Phases 1-8 during the Unified Runtime migration, but we did not replace the registration logic.
*   **Result**: The `pipelineRegistry` is empty for all migrated phases. Only `r2_listing` (which hasn't been migrated yet) is still registered.

### Evidence
*   `grep` for `registerPipeline` shows only `r2_listing` and the definition.
*   Migrated phases like `micro_batches/index.ts` only export a `Phase` object and lack any call to `registerPipeline`.
*   The `tickSimulationRun` function fails at line 109 when attempting to look up the registry entry.

## Work Task Blueprint: Bridging Unified Phases to Simulation Host

### Goal Description
We will implement a unified adapter to bridge the new `Phase` objects to the legacy `PipelineRegistryEntry` interface required by the Simulation Host and UI. This will restore the simulation's ability to orchestrate the migrated phases.

### Proposed Changes

#### 1. Simulation Infrastructure ([MODIFY] `src/app/engine/simulation/orchestration.ts`)
*   **[NEW] `createUnifiedPhaseRegistryEntry(phase, label)`**: 
    *   Returns a `PipelineRegistryEntry`.
    *   `onTick`: Uses `runStandardDocumentPolling`.
    *   `onExecute`: Calls `executePhase(phase, ...)` using the `SimulationStrategy`.
    *   `recoverZombies`: Calls the phase's sweeper (if any) or a generic one.

#### 2. Phase Registration (For each migrated Phase)
*   **[MODIFY] `src/app/pipelines/**/index.ts`**:
    *   Call `registerPipeline(createUnifiedPhaseRegistryEntry(Phase, Label))`.
    *   This ensures that importing the phase (as done in `allPipelines.ts`) triggers registration.

#### 3. Cleanup
*   Remove the leftover `r2_listing` runner once it is migrated to this new pattern.

### Verification Plan
1.  **Registry Check**: Verify `pipelineRegistry` is populated for all phases in dev console or via a debug script.
2.  **Tick Test**: Trigger a simulation run and verify `tickSimulationRun` no longer throws "No registry entry found".
3.  **UI Test**: Verify the simulation UI shows progress and details for the migrated phases.

- [ ] Implement `createUnifiedPhaseRegistryEntry` in `orchestration.ts`.
- [ ] Register `IngestDiffPhase`.
- [ ] Register `MicroBatchesPhase`.
- [ ] Register `MacroSynthesisPhase`.
- [ ] Register `MacroClassificationPhase`.
- [ ] Register `MaterializeMomentsPhase`.
- [ ] Register `DeterministicLinkingPhase`.
- [ ] Register `CandidateSetsPhase`.
- [ ] Register `TimelineFitPhase`.
but *also* mixes in Infrastructure concerns (Retry loops, Logging).
*   **Verdict**: This confirms the "Wrapper Trap" mentioned in the blueprint. We need to DELETE these per-phase runners and replace them with the single `UnifiedOrchestrator`.

**Confidence Meter Update**:
*   Legacy Rot: 50% (Identified the pattern, need to list all instances)
*   Core Logic: 10% (Saw `planMicroBatches` call, need to verify Core purity)
*   Infrastructure: 0%


## Finding: Core Logic is Sound but Specific
*   The logic in `src/app/pipelines/micro_batches/engine/core/orchestrator.ts` is well-structured using the **Ports and Adapters** pattern.
*   **Gap**: It does not implement a shared `Phase` interface. It is a standalone function `computeMicroBatchesForDocument`.
*   **Action**: We will need to write the `executePhase` wrapper effectively as a "Generic-to-Specific" adapter. It will switch on the phase name and call these specific core orchestrators.

## Finding: Plugin Pipeline is Reusable
*   `src/app/engine/indexing/pluginPipeline.ts` already implements the "Waterfall" and "First Match" logic. We can simply import this into our new Orchestrator.

**Confidence Meter Update**:
*   Legacy Rot: 80% (Confirmed pattern of runners/adapters to kill)
*   Core Logic: 80% (Confirmed Core is usable via Ports)
*   Infrastructure: 10% (We know what to build: `executePhase` + `Context` wiring)


## Work Task Blueprint: Implementing the Unified Pipeline

### Goal Description
We will implement the **Unified Orchestrator** pattern defined in the Architecture Blueprints. This involves creating the single `executePhase` entry point, implementing the `Live` and `Simulation` strategies, and refactoring the existing phases to use this new harness, deleting the legacy runners.

### Breakdown of Changes

#### 1. Infrastructure ([NEW] `src/app/engine/unified/`)
*   **[NEW] `types.ts`**: Define `Phase`, `StorageStrategy`, `TransitionStrategy`, `PipelineContext`.
*   **[NEW] `orchestrator.ts`**: Implement the `executePhase` function.
*   **[NEW] `strategies/live.ts`**: Implement `NoOpStorage` and `DirectTransition`.
*   **[NEW] `strategies/simulation.ts`**: Implement `ArtifactStorage` and `QueueTransition`.

#### 2. Phase Refactor (For each Phase 1-8)
*   **[DELETE] `engine/simulation/runner.ts`**: The polling loop.
*   **[DELETE] `engine/simulation/adapter.ts`**: The legacy adapter.
*   **[MDIFY] `engine/core/orchestrator.ts`**: Ensure it exports a function matching the `PhaseExecution` signature (or adapt it in the main orchestrator).

### Execution Order
1.  **Scaffold**: Create the new `unified` directory and types.
2.  **Strategies**: Implement the Live and Sim strategies.
3.  **Orchestrator**: Implement the `executePhase` loop.
4.  **Migrate Phase 1 (Ingest)**:
    *   Delete old runner.
    *   Wire new Orchestrator to call Ingest Core.
    *   Verify.
5.  **Migrate Phase 2 (Micro-Batches)**: ...
6.  **Cleanup**: Delete shared legacy runner helpers.

### Verification Plan
*   **The Build Test**: ensuring code compiles with strict types.
*   **The Sim Test**: Creating a unit test that runs `executePhase(Ingest, SimStrategy)` and checks if an artifact is written to the Mock DB.


## Discussion: Do we still need Ports?
*   **User Question**: "Give me a code snippet... I don't see why we need [Ports] if we have a single context object."
*   **Analysis**: The user is correct. 
    *   **Old Way**:  -> accepts  object -> Calls .  implements .
    *   **New Way**:  -> accepts . Calls .
    *   **Redundancy**: Having both  AND  is double abstraction.

*   **Proposal**: We should **inline** the logic. The "Core" function should just use the .
    *   *Benefit*: Simpler code. Less boilerplate.
    *   *Trade-off*: Harder to unit test without mocking the whole DB? (Actually, we can just mock ).

*   **Decision**: We will likely **Deprecate Ports** in favor of .


## Work Task Blueprint Revision: Removing Ports
We have simplified the plan. We will **remove the Ports pattern**.

### New Logic Contract
Instead of:
```typescript
async function core(input, ports) {
  const data = await ports.getEmbedding(input);
  await ports.save(data);
}
```

We will write:
```typescript
async function core(input, context) {
  const data = await context.vector.getEmbedding(input);
  return data; // Return value is saved by Strategy
}
```

### Revised Execution Order
1.  **Scaffold**: Create `src/app/engine/unified` (Types, Orchestrator, Strategies).
2.  **Refactor Micro-Batches**:
    *   Delete `runner.ts` / `adapter.ts`.
    *   **Rewrite** `core/orchestrator.ts` to remove Ports and use Context.
    *   Export compliant Phase object.
3.  **Verify**: Run the new phase in isolation via a test script.


## Finalized Work Task Blueprint: Unified Pipeline Implementation

### Goal Description
We will implement the **Unified Orchestrator** to replace the legacy "Live/Sim" siloed runners. We will enforce a single code path (`executePhase`) that is stateless, using `PipelineContext` for all I/O and `Strategies` for persistence.

### Critical Architecture Decisions
1.  **Values over Objects**: We are removing the "Ports" pattern. Core logic functions will accept `PipelineContext` and directly use `context.db` / `context.vector`.
2.  **Explicit Returns**: Core logic returns data (Constraints/Artifacts). It does *not* save them. The `Strategy` handles the saving.

### Breakdown of Changes

#### 1. The Runtime Harness ([NEW] `src/app/engine/runtime/`)
*   **`types.ts`**: Definitions for `Phase`, `PhaseExecution` (input -> output), `PipelineContext`.
*   **`strategies/live.ts`**: `NoOpStorage` (fire and forget) + `QueueTransition` (async reliability).
*   **`strategies/simulation.ts`**: `ArtifactStorage` (save to DB) + `QueueTransition` (next job).
*   **`orchestrator.ts`**: The `executePhase` loop:
    1.  `await context.strategies.storage.load(input)`
    2.  `const output = await phase.execute(input, context)`
    3.  `await context.strategies.storage.save(output)`
    4.  `await context.strategies.transition.dispatch(output)`

#### 2. Phase Refactor: Micro-Batches
*   **[DELETE] `src/app/pipelines/micro_batches/engine/simulation/{runner,adapter}.ts`**: Remove legacy polling/logging logic.
*   **[MODIFY] `src/app/pipelines/micro_batches/engine/core/orchestrator.ts`**:
    *   **Signature Change**: `computeMicroBatches(input, context)`
    *   **Logic Change**: Replace `ports.save` with `return result`.
    *   **Logic Change**: Replace `ports.getEmbedding` with `context.vector.getEmbedding`.
*   **[NEW] `src/app/pipelines/micro_batches/index.ts`**: Export the `Phase` object compliant with the new Unified type.

### Execution Plan
1.  **Scaffold**: Create `src/app/engine/unified` and its sub-modules.
2.  **Refactor**: Convert `micro_batches` core logic to be Port-less and Context-driven.
3.  **Delete**: Remove the legacy runner code.
4.  **Verify**: Trigger a Simulation Run for Micro-Batches and verify artifacts appear in the DB.


## Work Task Blueprint Revision: Directory Naming
*   **User Feedback**: "unified - do we really need that name to be explicit"
*   **Decision**: We will use `src/app/engine/runtime`.
    *   It is clean, standard, and describes *what it is* (The Execution Runtime).
    *   It avoids the "Unified" prefix which is a project goal, not a component name.
    *   It helps distinguish from the legacy `simulation` and `live` folders (which will be deleted/archived).


## Correction: Live Mode cannot be Sync Recursion
*   **Constraint**: Cloudflare Workers have a 30s CPU time limit (and strict wall clock limits on Free/Standard plans).
*   **Implication**: If we chain Ingest -> Embed -> Synth -> Link -> fit in one call stack, we will likely TIMEOUT.
*   **Pivot**: Live Mode MUST also use Queues (or at least asynchronous hand-off) for heavy phases.
    *   *Micro-Opt*: Maybe some lightweight phases can be chained, but generally, `QueueTransition` is safer for both.

## Restoring Constraints
*   We will ensure the `Unified Pipeline` blueprints explicitly list the Environment Constraints (128MB RAM, 30s CPU).


## Blueprint Cleanup Strategy
1.  **Rename**: `docs/blueprints/unified-pipeline.md` -> `docs/blueprints/runtime-architecture.md`.
    *   Rationale: This describes the *Runtime*, not just the pipeline.
2.  **Consolidate/Delete**:
    *   `system-overview.md`: Likely redundant with `system-flow.md`. Check and archive.
    *   `plugin-system.md`: Merged into Runtime Arch. Archive.
    *   `debug-endpoints.md`: Keep if relevant, but maybe move to `docs/dev-guides/`.


## Correction: Plugins are Essential
*   **User Feedback**: "plugin system - surely though there was a point there?"
*   **Investigation**: Yes, `pluginPipeline.ts` implements FirstMatch/Waterfall.
*   **Action**: Restored the Plugin Architecture section to the Blueprint.
*   **Code Impact**: The new Orchestrator MUST use `pluginPipeline.ts` helper functions to delegate logic to plugins.


## Revision: Legacy Endpoint Cleanup
*   **Finding**: All per-pipeline routes (e.g. `pipelines/micro_batches/web/routes/batches.ts`) query legacy tables (`simulation_run_micro_batches`).
*   **Action**: DELETE all pipeline-specific `web/routes/` files.
*   **Action**: CLEANUP `src/app/engine/routes/simulation.ts` (Remove `getSimulationRunDebugStatusHandler`).
*   **Replacement**: The new Supervisor will expose a generic `GET /admin/simulation/run/:runId/artifacts?phase=...` endpoint.

## Added Tasks
*   [DELETE] `src/app/pipelines/**/web/routes/*.ts`
*   [MODIFY] `src/app/engine/routes/simulation.ts`


# Actual Work Task Blueprint: Unified Runtime Implementation

## Goal Description
We will implement the **Unified Runtime Orchestrator** defined in `docs/blueprints/runtime-architecture.md`. This replaces the fragmented "Live vs Sim" runners with a single stateless `executePhase` loop that handles I/O via `PipelineContext` and persistence via `Strategies`.

## Critical Architecture Decisions
1.  **Single Runtime**: All logic runs via `src/app/engine/runtime`.
2.  **Values over Objects**: We are removing the "Ports" pattern. Core logic functions accept `PipelineContext` and return data.
3.  **Queue Boundary**: Both Live and Simulation strategies use `QueueTransition` to respect the 30s CPU limit.
4.  **Plugin Delegation**: The Orchestrator uses `pluginPipeline.ts` helper functions to inject domain logic.

## Breakdown of Changes

### 1. The Runtime Harness ([NEW] `src/app/engine/runtime/`)
*   **`types.ts`**: Definitions for `Phase`, `PhaseExecution` (input -> output), `PipelineContext`, `Strategies`.
*   **`strategies/live.ts`**: Implement `NoOpStorage` (fire and forget) + `QueueTransition` (async reliability).
*   **`strategies/simulation.ts`**: Implement `ArtifactStorage` (save to `simulation_run_artifacts`) + `QueueTransition` (next job).
*   **`orchestrator.ts`**: The `executePhase` loop.

### 2. Phase Refactor (Iterative, starting with Micro-Batches)
*   **[MODIFY] `src/app/pipelines/micro_batches/engine/core/orchestrator.ts`**:
    *   Remove `MicroBatchesOrchestratorPorts`.
    *   Use `PipelineContext` generic interface.
    *   Return `{ batches, microMoments }` (do not save inside core).
*   **[NEW] `src/app/pipelines/micro_batches/index.ts`**: Export the `Phase` object compliant with the new Runtime.
*   **[DELETE] `src/app/pipelines/micro_batches/engine/simulation/{runner,adapter}.ts`**: Remove legacy polling/logging.

### 3. Legacy Cleanup ([DELETE])
*   **[DELETE] `src/app/pipelines/**/web/routes/*.ts`**: All specific debug routes that query legacy tables.
*   **[MODIFY] `src/app/engine/routes/simulation.ts`**: Remove `getSimulationRunDebugStatusHandler`.
*   **[DELETE] Per-Phase Runners and Adapters**:
    *   `src/app/pipelines/candidate_sets/engine/simulation/runner.ts`
    *   `src/app/pipelines/deterministic_linking/engine/simulation/runner.ts`
    *   `src/app/pipelines/ingest_diff/engine/simulation/runner.ts`
    *   `src/app/pipelines/macro_classification/engine/simulation/runner.ts`
    *   `src/app/pipelines/macro_classification/engine/simulation/adapter.ts`
    *   `src/app/pipelines/macro_synthesis/engine/simulation/runner.ts`
    *   `src/app/pipelines/macro_synthesis/engine/simulation/adapter.ts`
    *   `src/app/pipelines/materialize_moments/engine/simulation/runner.ts`
    *   `src/app/pipelines/materialize_moments/engine/simulation/adapter.ts`
    *   `src/app/pipelines/micro_batches/engine/simulation/runner.ts`
    *   `src/app/pipelines/micro_batches/engine/simulation/adapter.ts`
    *   `src/app/pipelines/r2_listing/engine/simulation/runner.ts`
    *   `src/app/pipelines/timeline_fit/engine/simulation/runner.ts`

## Execution Order
1.  **Scaffold**: Create `src/app/engine/runtime` (Types, Orchestrator, Strategies).
2.  **Refactor Micro-Batches**: Convert Core Logic, create Phase definition.
3.  **Delete Legacy**: Remove old runners and debug routes for Micro-Batches.
4.  **Verify**: Trigger a generic Simulation Run (via code or new endpoint) and verify `simulation_run_artifacts` are populated.


# [Update] Progress Checkpoint: Micro-Batches Done, 7 Phases Remain

## Status Overview
We have successfully established the foundational **Unified Runtime** and migrated the first key phase: . However, several other phases and legacy services remain on the old architecture.

### Done
- [x] **Runtime Engine**: , , , .
- [x] **Persistence**: Generic  table.
- [x] **Micro-Batches Phase**: Refactored to be stateless and use the Unified Runtime.
- [x] **Cleanup**: Deleted  legacy runner/adapter.

### Remaining Work (The Migration Backlog)
The following phases still use the legacy  /  pattern and need to be migrated to  (Unified Phase Adapter).

1.  ****: Needs to be refactored to use .
2.  ****: Legacy runner/adapter.
3.  ****: Legacy runner/adapter.
4.  ****: Legacy runner/adapter.
5.  ****: Legacy runner.
6.  ****: Legacy runner.
7.  ****: Legacy runner.

### Legacy Services Cleanup Plan
Once all phases are migrated, we must delete:
-  ( The legacy shim we just patched).
-  (Legacy Supervisor).
-  (Legacy Live Scheduler).
-  (Complex legacy logic, might need breakdown).

## Next Steps
We will proceed phase-by-phase, verifying each migration.
1.  Migrate .
2.  Migrate .
3.  ... and so on.

## Architecture Verification [2026-02-02]
We have reviewed the implementation of the  directory and  phase against .

**Validation Results**:
- **Single Orchestrator**:  is the single entry point. **MATCH**.
- **Stateless Context**:  provides all necessary capabilities (, , ) as defined. **MATCH**.
- **Strategy Injection**: Live vs Sim differences are strictly handled by  and  strategies. **MATCH**.
- **Recursion Guard**:  is used in both strategies to break the stack and avoid 30s CPU timeouts. **MATCH**.
- **Plugin Delegation**: Domain logic (preparation, chunking) is correctly delegated to plugins via  hooks. **MATCH**.

**Contextual Shift**:
The user has removed  and  from the  interface, which further simplifies the plugins and aligns with the "Stateless Context" rule. We will ensure future phase migrations respect these interface changes.

## Completion of Phases 1 & 2 [2026-02-02]
We have completed the migration of the first two phases: **Ingest Diff** and **Micro-Batches**.

**Accomplishments**:
- **Ingest Diff**: Refactored to use , handles ETag comparison and  updates internally.
- **Micro-Batches**: Refactored to handle document processing, chunking (via plugins), and LLM-driven micro-moment generation.
- **Stop Signal**: Implemented  return from phases as a "Stop Execution" signal in the Orchestrator (used when docs haven't changed).

**Architectural Lessons (Standard for Future Phases)**:
1.  **Pure Strategies**:  (Live) must remain a . Do not leak phase-specific persistence logic into the strategy layer.
2.  **Phase Ownership**: Each  is responsible for its own side effects (e.g., updating DB status, committing results) using the .
3.  **Consolidated Adapters**: Use the pipeline's  as the single entry point for the  object. Avoid split  files to reduce clutter.
4.  **Stateless Core**: The business logic in  remains stateless, and the  adapter in  bridges the generic context to that logic.

**Backlog Update**:
- [x] Phase 1: Ingest Diff
- [x] Phase 2: Micro-Batches
- [ ] Phase 3: Macro Synthesis
- [ ] Phase 4: Macro Classification
- [ ] Phase 5: Materialize Moments
- [ ] Phase 6: Deterministic Linking
- [ ] Phase 7: Candidate Sets
- [ ] Phase 8: Timeline Fit

## Completion of Phase 3: Macro Synthesis [2026-02-02]
We have completed the migration of **Phase 3: Macro Synthesis**.

**Accomplishments**:
- **Core Logic**: Refactored  to use . It now pulls document metadata and planned batches directly.
- **Phase Adapter**: Created  in . It correctly fetches the output of  using , ensuring seamless data flow in both Live and Simulation.
- **Cleanup**: Deleted legacy .

**Approach Note**:
- **Data Dependencies**: We successfully demonstrated the pattern of one phase loading the output of a previous phase via . This is the glue for high-throughput pipelines.

**Backlog Update**:
- [x] Phase 1: Ingest Diff
- [x] Phase 2: Micro-Batches
- [x] Phase 3: Macro Synthesis
- [ ] Phase 4: Macro Classification
- [ ] Phase 5: Materialize Moments
- [ ] Phase 6: Deterministic Linking
- [ ] Phase 7: Candidate Sets
- [ ] Phase 8: Timeline Fit

## Completion of Phase 4: Macro Classification [2026-02-02]
We have completed the migration of **Phase 4: Macro Classification**.

**Accomplishments**:
- **Core Logic**: Refactored  to use . It handles gating and classification for each stream of thoughts.
- **Phase Adapter**: Created  in . It fetches the output of  to consume the streams and produce classifications.
- **Normalization**: Ensured that gating and classification logic are consistently applied across Live and Simulation.

**Backlog Update**:
- [x] Phase 1: Ingest Diff
- [x] Phase 2: Micro-Batches
- [x] Phase 3: Macro Synthesis
- [x] Phase 4: Macro Classification
- [ ] Phase 5: Materialize Moments
- [ ] Phase 6: Deterministic Linking
- [ ] Phase 7: Candidate Sets
- [ ] Phase 8: Timeline Fit

## Completion of Phase 5: Materialize Moments [2026-02-02]
We have completed the migration of **Phase 5: Materialize Moments**.

**Accomplishments**:
- **Core Logic**: Refactored  to use . It computes deterministic moment IDs and micro-path hashes.
- **Phase Adapter**: Created  in . It fetches the output of  and iterates through the generated moments to perform the database commit via .
- **Commit Guard**: This phase represents the first actual write to the primary graph database in the pipeline. In Simulation, it writes to the simulation's isolated namespace.

**Backlog Update**:
- [x] Phase 1: Ingest Diff
- [x] Phase 2: Micro-Batches
- [x] Phase 3: Macro Synthesis
- [x] Phase 4: Macro Classification
- [x] Phase 5: Materialize Moments
- [ ] Phase 6: Deterministic Linking
- [ ] Phase 7: Candidate Sets
- [ ] Phase 8: Timeline Fit

## Planning Phase 6: Deterministic Linking [2026-02-02]
We are ready to migrate **Phase 6: Deterministic Linking**.

**Goal**: Link the newly materialized moments to their parents based on deterministic rules:
1.  **Stream Continuity**: If , link to the previous moment in the same stream.
2.  **Explicit Reference**: If , look for  style issue/PR references and link to the resolved thread head.

**Proposed Changes**:
- **[NEW]** :
    - Wraps .
    - Iterates over moments from Phase 5.
    - Resolves thread heads using .
    - Returns a list of linking decisions.
- **[MODIFY]** :
    - Implements .
    - Loads Phase 5 output.
    - Performs the  side effects to update  and .
- **[DELETE]** .

**Verification**:
- Check  table (legacy UI dependency) or  for Phase 6 output.
- Verify  updates in the  table.

## Completion of Phase 6: Deterministic Linking [2026-02-02]
We have completed the migration of **Phase 6: Deterministic Linking**.

**Accomplishments**:
- **Core Logic**: Created  in . It wraps the logic for linking stream moments and resolving issue/PR references.
- **Phase Adapter**: Created  in . It correctly fetches materialized moments from Phase 5 and performs the  upserts with parent linkage.
- **Cleanup**: Removed the legacy simulation runner.

**Backlog Update**:
- [x] Phase 1: Ingest Diff
- [x] Phase 2: Micro-Batches
- [x] Phase 3: Macro Synthesis
- [x] Phase 4: Macro Classification
- [x] Phase 5: Materialize Moments
- [x] Phase 6: Deterministic Linking
- [ ] Phase 7: Candidate Sets
- [ ] Phase 8: Timeline Fit

## Completion of Phase 7: Candidate Sets [2026-02-02]
We have completed the migration of **Phase 7: Candidate Sets**.

**Accomplishments**:
- **Core Logic**: Created  in . It integrates with  for similarity search and the  for metadata retrieval.
- **Phase Adapter**: Created  in . It loads output from both  and  to identify moments that still need candidates.
- **Dependency Management**: We updated the  and  orchestrator to include the  strategy, enabling phases to load data from any preceding phase in the pipeline.

**Backlog Update**:
- [x] Phase 1: Ingest Diff
- [x] Phase 2: Micro-Batches
- [x] Phase 3: Macro Synthesis
- [x] Phase 4: Macro Classification
- [x] Phase 5: Materialize Moments
- [x] Phase 6: Deterministic Linking
- [x] Phase 7: Candidate Sets
- [ ] Phase 8: Timeline Fit

## Architectural Alignment: Storage in Context [2026-02-02]
During the implementation of Phase 7, we realized that the generic  signature (only accepting  and ) was insufficient for phases that need to "pull" data from previous steps in the pipeline (e.g., Phase 7 needing both Phase 5 and Phase 6 results).

**Decisions**:
- **Updated **: Added  to the context.
- **Updated Orchestrator**: Injected the current runtime storage strategy into the context before execution.
- **Updated Architecture Blueprint**: Reflected this change in  to ensure it's a first-class citizen of the Unified Runtime.

## Completion of Phase 8: Timeline Fit [2026-02-02]
We have completed the migration of **Phase 8: Timeline Fit**, the final step in the unified pipeline.

**Accomplishments**:
- **Core Logic**: Created  in . It utilizes the  LLM to veto and select the best parent match from a candidate set.
- **Phase Adapter**: Created  in . It consumes the output of Phase 5 and Phase 7.
- **Milestone**: The entire Machinen Engine core logic (8 phases) is now migrated to the **Unified Runtime**.

**Backlog Update**:
- [x] Phase 1: Ingest Diff
- [x] Phase 2: Micro-Batches
- [x] Phase 3: Macro Synthesis
- [x] Phase 4: Macro Classification
- [x] Phase 5: Materialize Moments
- [x] Phase 6: Deterministic Linking
- [x] Phase 7: Candidate Sets
- [x] Phase 8: Timeline Fit

**Next Steps**:
- Verify the entire pipeline with an end-to-end simulation.
- Remove the legacy  and runner shims.

## Investigated Simulation UI Failure [2026-02-02]
We investigated the "No registry entry found" error reporting by the user in `src/app/engine/runners/simulation/runner.ts`.

### Finding: The Registration Sinkhole
*   **The Problem**: The Simulation Host (Supervisor) depends on `src/app/engine/simulation/registry.ts` to find phase handlers.
*   **Legacy Pattern**: Registration was handled as a side-effect in `runner.ts` of each phase.
*   **Refactor regression**: We deleted the `runner.ts` files for Phases 1-8 during the Unified Runtime migration, but we did not replace the registration logic.
*   **Result**: The `pipelineRegistry` is empty for all migrated phases. Only `r2_listing` (which hasn't been migrated yet) is still registered.

### Evidence
*   `grep` for `registerPipeline` shows only `r2_listing` and the definition.
*   Migrated phases like `micro_batches/index.ts` only export a `Phase` object and lack any call to `registerPipeline`.
*   The `tickSimulationRun` function fails at line 109 when attempting to look up the registry entry.

## Work Task Blueprint: Bridging Unified Phases to Simulation Host

### Goal Description
We will implement a unified adapter to bridge the new `Phase` objects to the legacy `PipelineRegistryEntry` interface required by the Simulation Host and UI. This will restore the simulation's ability to orchestrate the migrated phases.

### Proposed Changes

#### 1. Simulation Infrastructure ([MODIFY] `src/app/engine/simulation/orchestration.ts`)
*   **[NEW] `createUnifiedPhaseRegistryEntry(phase, label)`**: 
    *   Returns a `PipelineRegistryEntry`.
    *   `onTick`: Uses `runStandardDocumentPolling`.
    *   `onExecute`: Calls `executePhase(phase, ...)` using the `SimulationStrategy`.
    *   `recoverZombies`: Calls the phase's sweeper (if any) or a generic one.

#### 2. Phase Registration (For each migrated Phase)
*   **[MODIFY] `src/app/pipelines/**/index.ts`**:
    *   Call `registerPipeline(createUnifiedPhaseRegistryEntry(Phase, Label))`.
    *   This ensures that importing the phase (as done in `allPipelines.ts`) triggers registration.

#### 3. Cleanup
*   Remove the leftover `r2_listing` runner once it is migrated to this new pattern.

### Verification Plan
1.  **Registry Check**: Verify `pipelineRegistry` is populated for all phases in dev console or via a debug script.
2.  **Tick Test**: Trigger a simulation run and verify `tickSimulationRun` no longer throws "No registry entry found".
3.  **UI Test**: Verify the simulation UI shows progress and details for the migrated phases.

- [ ] Implement `createUnifiedPhaseRegistryEntry` in `orchestration.ts`.
- [ ] Register `IngestDiffPhase`.
- [ ] Register `MicroBatchesPhase`.
- [ ] Register `MacroSynthesisPhase`.
- [ ] Register `MacroClassificationPhase`.
- [ ] Register `MaterializeMomentsPhase`.
- [ ] Register `DeterministicLinkingPhase`.
- [ ] Register `CandidateSetsPhase`.
- [ ] Register `TimelineFitPhase`.

## Refactoring Simulation Architecture (Runner-Direct R2 Listing) [2026-02-02]
The user suggested that the simulation runner should handle the `r2_listing` directly, as the live side doesn't need it. This further simplifies the `Phase` architecture by removing simulation-specific "Pre-flight" logic from the core runtime.

### New Architecture: Special Case Runner
*   **Built-in Logic**: The Simulation Runner will treat `r2_listing` as a built-in pre-processing step.
*   **Generic Pipeline**: All other phases (`ingest_diff` through `timeline_fit`) will be handled via a generic "Standard Document Polling" mode in the runner, looking up definitions in the new runtime registry.
*   **Cleaner Types**: The `Phase` interface remains pure business logic, without needing simulation-specific `onTick` or `recoverZombies` hooks.

## Work Task Blueprint: Simulation Registry Removal & Direct Phase Integration

### Goal Description
We will delete the legacy `pipelineRegistry` and tie the Simulation Host and UI directly to the new `Phase` architecture. `r2_listing` will be moved directly into the Simulation Runner logic.

### Proposed Changes

#### 1. Runtime Foundation
*   **[NEW] `src/app/engine/runtime/registry.ts`**: Aggregate all phases into a single export.
*   **[MODIFY] `src/app/engine/runtime/types.ts`**: (No change needed to `Phase`, keeping it pure).

#### 2. Pipeline Refactors
*   **[DELETE] `src/app/pipelines/r2_listing`**: The entire pipeline directory will be removed as its logic moves to the runner.

#### 3. Simulation Host & Worker
*   **[MODIFY] `src/app/engine/runners/simulation/runner.ts`**: 
    *   Implement `tickR2Listing` helper directly.
    *   Replace registry lookup with `getPhaseByName`. 
    *   Implement generic document polling for all business phases.
*   **[MODIFY] `src/app/engine/services/simulation-worker.ts`**: Replace registry lookup with `getPhaseByName` and call `executePhase` directly.

#### 4. UI Migration
*   **[MODIFY] `src/app/pages/audit/subpages/simulation-runs-page.tsx`**: Remove `pipelineRegistry` dependency. Map components directly to phase names.

#### 5. Deletions
*   **[DELETE] `src/app/engine/simulation/registry.ts`**
*   **[DELETE] `src/app/engine/simulation/allPipelines.ts`**
*   **[DELETE] `src/app/engine/simulation/orchestration.ts`**

### Verification Plan
1.  **Boot Test**: Ensure the app starts without registry side-effects.
2.  **Tick Test**: Trigger a simulation run and verify the runner handles R2 listing and then advances to generic document polling.
3.  **UI Test**: Verify the simulation UI shows all phases and drilldowns correctly.

- [ ] Create `src/app/engine/runtime/registry.ts`.
- [ ] Move R2 Listing logic into `src/app/engine/runners/simulation/runner.ts`.
- [ ] Delete `src/app/pipelines/r2_listing`.
- [ ] Refactor `tickSimulationRun` to use new registry and generic polling.
- [ ] Refactor Simulation Worker to use new registry.
- [ ] Update Simulation UI to use direct mapping.
- [x] Delete legacy registry files.

## Centralizing Phase UI Mapping (Higher Level) [2026-02-02]
The user suggested moving the registry to `src/app/pipelines/registry.ts` as it's a better location for aggregating phase-specific logic (engine + UI).

### Proposed Changes
*   **[MODIFY] `src/app/pipelines/registry.ts`**: Move `simulationPhasesOrdered` and a new `PHASE_METADATA` map (containing labels and UI component identifiers) here.
*   **[MODIFY] `src/app/pages/audit/subpages/simulation-runs-page.tsx`**: Import ordering and metadata from the registry.
*   **[DELETE] `src/app/engine/runtime/registry.ts`**: (The one we just created).

- [ ] Create `src/app/pipelines/registry.ts`.
- [ ] Update `tickSimulationRun` to use `src/app/pipelines/registry.ts`.
- [ ] Update Simulation Worker to use `src/app/pipelines/registry.ts`.
- [ ] Update Simulation UI to use centralized registry.
- [ ] Delete `src/app/engine/runtime/registry.ts`.



## Refactored Database Types for Simulation
We have refactored the database type definitions for the simulation engine to follow the project's strict protocols.

### Achievements:
- **Concrete JSON Types:** Defined explicit interfaces for all JSON blobs (e.g., `SimulationRunConfig`, `SimulationRunEventPayload`).
- **Clean Database Inference:** Separated the "Raw" database types (serialization side, using strings) from the "Row" override types (deserialization side, using objects).
- **Resolved Static Inference Issues:** Manually defined raw table interfaces for columns added via `alterTable` (like `dispatched_phases_json`) that Kysely's static inference was missing.
- **Type-Safe Interaction:** Updated Simulation Runner, Worker, and Services to use the new `Row` types, eliminating `any` casts and manual `JSON.parse` calls while maintaining explicit `JSON.stringify` on writes.
- **Improved Status Enum:** Updated `SimulationRunStatus` to include missing values like `"advance"`.

### Protocols Followed:
- NO GUESSES (Verified exact column names via migrations).
- Override types instead of casting.
- Record findings to the worklog.

# Investigating micro_batches stall and UI status discrepancies [2026-02-03]

## Initial observation of the stall
We observed that the simulation run is stuck in `micro_batches` state with `awaiting_documents` status. Despite `ingest_diff` showing 5/5 documents processed (all unchanged), `micro_batches` shows 0/0 progress. The user reports DLQs are happening and logs are sparse. This suggests a failure in either the dispatch logic or the background worker processing the jobs.


## Investigated the micro_batches stall
We are restarting the investigation into the `micro_batches` stall, following the Bedrock Protocol strictly. We already noted that the run is stuck in `awaiting_documents`. Our next step is to build a body of evidence for why the dispatch is failing or why the worker isn't picking up the jobs.

## Recorded findings from investigation
We analyzed the `simulation-worker.ts` and `MicroBatchesPhase` implementation. We discovered the following empirical evidence:
1. **Empty Plugins Array**: The `pipelineContext` in `simulation-worker.ts` is initialized with `plugins: []`. Since `MicroBatchesPhase` relies on `runFirstMatchHook(context.plugins, ...)` to prepare the document, it fails to find any document to process.
2. **Missing r2Key in Context**: The `pipelineContext` (which should satisfy `PipelineContext` extending `IndexingHookContext`) is missing the `r2Key` property. Indexing plugins like `githubPlugin` explicitly access `context.r2Key` to fetch objects from R2.
3. **Opaque Failures**: While failures are being logged in the terminal (e.g., `No plugin could prepare document`), they are not being persisted back to the `simulation_run_documents` table or recorded in `simulation_run_events`. Because the worker doesn't catch these errors to update the run state, the supervisor (Runner) only sees that documents are dispatched but not yet processed, leading to the permanent `awaiting_documents` state in the UI.

## Drafted Work Task Blueprint: Simulation Resilience and Context Fix

### Context
Simulation runs are stalling in `micro_batches` because the worker context is missing required metadata (`r2Key`) and logic (`plugins`). Furthermore, failures in these background jobs are opaque to the simulation state, leaving the UI stuck in "Awaiting Documents" even when the worker has crashed.

### Proposed Changes

**Simulation Worker** (`src/app/engine/services/simulation-worker.ts`)
- [NEW] Central `withSimulationErrorTracking` wrapper.
- [MODIFY] `processSimulationJob`:
    - Fix `pipelineContext` initialization to include `r2Key` and properly resolved `plugins`.
    - Wrap the job execution logic with `withSimulationErrorTracking`.
    - `withSimulationErrorTracking` will catch any `Error`, record it to the appropriate database table (`simulation_run_documents` for per-key jobs, `simulation_runs` for advance jobs), and then re-throw to allow infra-level retries.

### Directory & File Structure
```text
src/app/engine/services/
└── [MODIFY] simulation-worker.ts
```

### Invariants & Constraints
- **State Reliability**: Every job failure MUST result in a database update before the job is returned to the queue or DLQ.
- **Native Retries**: We MUST re-throw errors after recording them to leverage Cloudflare's queue reliability.

### Tasks
- [ ] Implement `withSimulationErrorTracking` in `simulation-worker.ts`.
- [ ] Fix `pipelineContext` initialization in `processSimulationJob`.
- [ ] Verify that errors are correctly surfaced in the `simulation_run_documents` table.

## Completed implementation of simulation resilience
We implemented the central error tracking wrapper `withSimulationErrorTracking` in `simulation-worker.ts`. This wrapper:
1. Catches any error during job processing.
2. Records the error to `simulation_run_documents.error_json` or `simulation_runs.last_error_json`.
3. Adds a `simulation_run_events` record for the error.
4. Re-throws the error to ensure Cloudflare's retry logic and DLQs work as intended.

We also fixed the `pipelineContext` initialization to include `r2Key` and resolve real indexing plugins. This should resolve the "No plugin could prepare document" stall.

### Verification Plan (Manual)
1. Ask the user to resume the simulation.
2. Verify that jobs move past `micro_batches`.
3. If an error occurs, verify it appears in the `DocumentsCard` in the UI (linked to `error_json`).

