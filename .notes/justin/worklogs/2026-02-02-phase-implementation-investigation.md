# Worklog: Phase Implementation Deep Dive [2026-02-02]

## Priming: The Blueprint Gap
We have new architecture blueprints that define the "Unified Orchestrator", "Stateless Context", and "8-Phase I/O Contract".
Now we must implement this.
The goal of this investigation is to map the *Blueprint* to the *Code* and identify the specific diffs needed.

## Investigation Strategy (Confidence Meter)
We will audit each phase against its Blueprint definition.
- [ ] **Infrastructure**:  definition vs .
- [ ] **Phase 1 (Ingest)**: Plugin interface match?
- [ ] **Phase 2 (Micro-Batches)**: Does  actually output  (vectors)?
- [ ] **Phase 5 (Materialize)**: Is the Commit logic centralized?
- [ ] **Phase 6-8 (Linking)**: Do we have the  vs  split in code?

Current Confidence: Low (Codebase is likely drifted).


## Audit Findings
### 1. Context Mismatch
*   **Blueprint**: `PipelineContext` has `db`, `vector`, `env`, `llm`.
*   **Code**: `IndexingHookContext` only has `r2Key`, `env`, `momentGraphNamespace`.
*   **Action Required**: We need to define `PipelineContext` extending `IndexingHookContext` and update the Orchestrator signatures.

### 2. Ingest Phase
*   **Blueprint**: Plugin normalizes -> `Document`.
*   **Code**: `ingest_diff/engine/core/orchestrator.ts` only handles Etags/Checksums. It returns `{ etag, changed }`. The actual *Fetch & Normalize* must happen downstream, likely in `micro_batches` or a missing piece of `ingest`.
*   **Gap**: The Blueprint says Ingest produces a `Document`. The Code says Ingest produces a `Signal` (Changed/Not Changed). We need to decide if we fetch the content in Phase 1 or Phase 2.
    *   *Decision*: Blueprint says Phase 1. We should update code to actually fetch and return the Document, OR verify if `micro_batches` does the fetch.


### 3. Micro-Batches Phase
*   **Blueprint**: Split -> Embed -> Store MicroMoments.
*   **Code**: `micro_batches/engine/core/orchestrator.ts`:
    *   Calls `planMicroBatches` (Chunking).
    *   Calls `getEmbeddings` (Vectorizing).
    *   Calls `upsertMicroMomentsBatch` (Storing).
*   **Verdict**: **High Alignment**. The code actually does exactly what the Blueprint says.
*   **Minor Issue**: It also calls `getMicroPromptContext`, which arguably belongs in Macro-Synthesis? But it's needed for the Embedding metadata likely.

(Confidence Meter Check: Infrastructure: Low. Phase 1: Low. Phase 2: High. Phase 5: Pending...)


### 4. Materialize Phase
*   **Blueprint**: Input `ClassifiedStream` -> `INSERT moments`.
*   **Code**: `materialize_moments/engine/core/orchestrator.ts`:
    *   Iterates `input.streams`.
    *   Calls `ports.computeMomentId` (Stable ID).
    *   Calls `ports.upsertMoment` (The Commit).
*   **Verdict**: **High Alignment**.
*   **Observation**: The input type says `streams: Array<{ streamId: string; macroMoments: any[] }>`. This `any[]` is weak typing. We should define `ClassifiedMoment` type to match the Blueprint.

### 5. Linking Phases (Preliminary)
We need to check `deterministic_linking`, `candidate_sets`, and `timeline_fit`.


### 6. Linking Phases (Critical Finding)
*   **Blueprint**: Unified Orchestrator pattern.
*   **Code**: `deterministic_linking`, `candidate_sets`, and `timeline_fit` **DO NOT have a core directory**. They only have `engine/simulation`.
*   **Implication**: These phases are NOT unified yet. They are likely running pure simulation code.
*   **Action**: We must check `engine/simulation` to see if the logic is embedded there, and then plan to extract it to `core/orchestrator.ts`.

(Confidence Meter: Linking Phases = Zero Alignment. Code is legacy.)


### 7. Deterministic Linking logic
*   **Observation**: `deterministic_linking/simulation/runner.ts` calls `import { computeDeterministicLinkingDecision } from "../../../../engine/core/linking/deterministicLinkingOrchestrator"`.
*   **Verdict**: The "Core" logic exists but it lives in `src/app/engine/core/linking`, not in the phase directory.
*   **Unified Gap**: The Phase definition is trapped in `runner.ts`. There is no `orchestrator.ts` in the phase folder that implements the generic `executePhase` contract.
*   **Refactor Goal**: Move the orchestration logic from `runner.ts` into a proper `PhaseCore` or `Orchestrator` exposed by the phase, so that Live/Sim can both call it.

## Work Task Blueprint: Implementation Plan

### Goal Description
Implement the "Unified Orchestrator" contract across all 8 phases, ensuring strict adherence to the "Stateless Context" and "Phase I/O" definitions.

### Breakdown
1.  **Define Context**: Create `PipelineContext` in `types.ts`.
2.  **Phase 1 (Ingest)**: Add `IngestOrchestrator` to `ingest_diff/engine/core` that returns `Document`. Refactor Sim Runner to use it.
3.  **Phase 2 (Micro-Batches)**: Update orchestrator to use `PipelineContext` (minor refactor).
4.  **Phase 5 (Materialize)**: Rename input from `streams` to `classifiedStream` for clarity. Ensure Context usage.
5.  **Phase 6-8 (Linking)**:
    *   Create `src/app/pipelines/<phase>/engine/core/orchestrator.ts`.
    *   Import logic from `src/app/engine/core/linking`.
    *   Switch Sim Runner to use the new Orchestrator.

### Phase 1: Context & Ingest
*   We will start here.

