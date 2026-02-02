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
*   `adapter.ts` contains the specific implementation of the phase but *also* mixes in Infrastructure concerns (Retry loops, Logging).
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

#### 1. The Unified Harness ([NEW] `src/app/engine/unified/`)
*   **`types.ts`**: Definitions for `Phase`, `PhaseExecution` (input -> output), `PipelineContext`.
*   **`strategies/live.ts`**: `NoOpStorage` (fire and forget).
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

