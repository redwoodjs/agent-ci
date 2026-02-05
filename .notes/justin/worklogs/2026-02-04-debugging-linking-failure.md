# Debugging Linking Failure 2026-02-04

## Initiated investigation into deterministic linking failure
We are investigating why issue #933 is failing to link to #522 in the `deterministic_linking` phase.

## Discovered root cause of linking failure
- The raw document scanning regex `/#(\d{1,10})/` in `orchestrator.ts` is not global (`g`), so it only finds the first match.
- If the document contains its own issue number (e.g. #933) before the target (#522), it stops at the first match.
- The self-link check happens AFTER choosing a candidate, which results in a null parent if the first candidate is self.
- We need a global scan and an explicit filter for the current document's issue number.

## Drafted Work Task Blueprint

### Context
We are resolving the linking failure for issue #933 -> #522 in the `deterministic_linking` phase. The root cause is twofold:
1. The raw document regex scan was non-global, stopping at the first match.
2. The document's own issue number (#933) appeared before the target (#522) in the raw content, causing it to be picked as the link candidate, which then failed the self-link check.

### Breakdown of Planned Changes
* Modify `deterministic_linking/orchestrator.ts`:
    - Implement global regex scanning for issue references.
    - Parse current document's issue number to explicitly filter it from candidates.
    - Log ignored self-references for auditability.

### Directory & File Structure
src/app/pipelines/deterministic_linking/engine/core/
└── [MODIFY] orchestrator.ts

### Types & Data Structures
No changes to public interfaces. Internal logic refinement only.

### Invariants & Constraints
- **Self-Link Prevention**: A document must never link to itself.
- **Ordered Resolution**: We should try to resolve issue references in the order they appear in the document, skipping the self-reference.

### System Flow (Snapshot Diff)
- **Previous Flow**: Scan raw content -> Pick first match -> If match is self, return null.
- **New Flow**: Scan raw content for ALL matches -> Skip self-matches -> Resolve first remaining match.

### Suggested Verification (Manual)
- Rerun `needle-sim-1` and check `deterministic_linking` logs for "found fallback issueRef" and potential self-link skips.

### Tasks
- [ ] Implement global scan with self-link filtering in `deterministic_linking`
- [ ] Verify fix with needle simulation

## Implemented global scan and self-link filtering
We updated `orchestrator.ts` in `deterministic_linking` to use a global regex scan (`matchAll`) and a self-link filter based on the current document's issue number.
- Added `parseIssueNumberFromDocumentId` helper.
- Updated `computeDeterministicLinkingDecision` to skip self-references while scanning raw content.

## Discovered root cause of blank Knowledge Graph UI
- The Knowledge Graph server actions were then applying the prefix again, resulting in `sim:sim` as the effective namespace.
- This mismatch caused the UI to look at the wrong Durable Object (`sim:sim:moment-graph-v2` instead of `sim:moment-graph-v2`).
- We will fix this by passing the base namespace instead of the effective one in the simulation run links.

## Work Task Blueprint: Resolve Linking Failure, Retrieval Stall, and UI Discrepancy
# Resolve Linking Failure, Retrieval Stall, and UI Discrepancy

## Context
We are resolving interrelated issues discovered during needle simulation runs:
1. **Retrieval Stall**: Vectorize v7 indexes appear stagnant. We rotated to **v8**.
2. **Deterministic Linking Failure**: The reference from #933 to #522 is missed because it resides in the raw document body but wasn't synthesized into the moment's summary.
3. **Timeline Fit UI Bug**: The UI displays "Rejected / No Fit" even when a parent is successfully chosen, because the `outcome` field is missing from the orchestrator's output.
4. **Blank Knowledge Graph UI**: The link from simulation runs to the Knowledge Graph is broken due to double-prefixing when the base namespace is empty.

## Proposed Changes

### Core Engine (Vectorize v8 & Metadata Indexes)
*   **Rotation**: Updated `wrangler.jsonc` to point to `moment-index-v8`, `subject-index-v8`, and `rag-index-v8`.
*   **Binding**: Added missing `SUBJECT_INDEX` binding.

### Deterministic Linking (Improved Full Doc Scan)
#### [MODIFY] [orchestrator.ts](file:///Users/justin/rw/worktrees/machinen_simplify-phase-arch/src/app/pipelines/deterministic_linking/engine/core/orchestrator.ts)
*   **Fix Regex**: Change `rawDocumentContent.match(/#(\d{1,10})/)` to a global scan `matchAll(/#(\d{1,10})/g)` to find all potential issue references.
*   **Extract Self-ID**: Parse the current document's issue number from `childDocumentId`.
*   **Filter & Resolve**: Iterate through matches, ignore self-references, and resolve the first valid one.

### Timeline Fit (UI & Logic Alignment)
#### [MODIFY] [timeline_fit/orchestrator.ts](file:///Users/justin/rw/worktrees/machinen_simplify-phase-arch/src/app/pipelines/timeline_fit/engine/core/orchestrator.ts)
*   Add `outcome` property to the return object: "fit" if `chosenParentId` is set, otherwise "no-fit".

### Knowledge Graph UI Fix
#### [MODIFY] [simulation-runs-page.tsx](file:///Users/justin/rw/worktrees/machinen_simplify-phase-arch/src/app/pages/audit/subpages/simulation-runs-page.tsx)
*   Pass the raw `momentGraphNamespace` and `momentGraphNamespacePrefix` in the Knowledge Graph link instead of the manually applied effective namespace. This avoids double-prefixing in the server actions.

### Directory & File Structure
```text
src/app/
├── pipelines/
│   ├── deterministic_linking/
│   │   └── engine/core/
│   │       └── [MODIFY] orchestrator.ts
│   └── timeline_fit/
│       └── engine/core/
│           └── [MODIFY] orchestrator.ts
├── pages/audit/subpages/
│   └── [MODIFY] simulation-runs-page.tsx
└── [MODIFY] wrangler.jsonc
```

### Invariants & Constraints
*   **Source Truth**: Deterministic linking should prioritize explicit references in the raw document over synthesized summaries.
*   **UI Consistency**: The `outcome` field must accurately reflect the `chosenParentId` state.

### System Flow (Snapshot Diff)
*   **Previous Flow**: 
    1. Deterministic linking only scans moment summary.
    2. Simulation runs generate self-prefixed links (e.g. `namespace=sim&prefix=sim`).
*   **New Flow**:
    1. Deterministic linking fallbacks to raw R2 content scan.
    2. Simulation runs pass raw components (`namespace=null&prefix=sim`), letting the action compute the correct effective namespace (`sim`).

### Suggested Verification (Manual)
1. **Deterministic Linking**: Rerun simulation 933 and verify in logs that it skips `#933` and finds `#522`.
2. **Timeline Fit**: Verify simulation UI shows "Fit" (green check) instead of "Rejected" when a parent is found.
3. **Knowledge Graph UI**: Navigate from a simulation run page to "Open in Knowledge Graph" and verify the graph is no longer blank.

### Tasks
- [x] Rotate to Vectorize v8 indexes
- [x] Fix deterministic linking failure for #933 -> #522
- [x] Fix missing `outcome` in `timeline_fit`
- [ ] Fix blank Knowledge Graph UI link
- [ ] Verify fix with needle simulation
- Simulation runs with null base namespace and a prefix (e.g. 'sim') were generating links with `namespace=sim&prefix=sim`.

## Correction and Alignment
We realized that the Work Task Blueprint appended above contained several items already marked as completed because they were addressed during the preceding investigation and immediate implementation turns.
- **Vectorize v8 Rotation**: Verified as complete.
- **Deterministic Linking (#933 -> #522)**: Global scan and self-link filtering implemented.
- **Timeline Fit Outcome**: Confirmed as already present in `orchestrator.ts`.

The remaining active task is the Knowledge Graph UI fix.
- **Next**: Fix the double-prefixing in `simulation-runs-page.tsx`.

## Work Task Blueprint: Resolve Knowledge Graph UI Blankness
This blueprint focuses only on the remaining work.

# Resolve Knowledge Graph UI Blankness

## Context
We have resolved the retrieval stalls and deterministic linking failures in previous steps. The remaining UI issue is that the "Open in Knowledge Graph" link from simulation runs leads to a blank page due to double-prefixing of the namespace.

## Proposed Changes

### Knowledge Graph UI Fix
#### [MODIFY] [simulation-runs-page.tsx](file:///Users/justin/rw/worktrees/machinen_simplify-phase-arch/src/app/pages/audit/subpages/simulation-runs-page.tsx)
*   **Fix**: Pass the raw `momentGraphNamespace` and `momentGraphNamespacePrefix` as distinct parameters (`namespace` and `prefix`) in the URL search params.
*   **Rationale**: The `getKnowledgeGraphAction` (and other server actions) already correctly handle combining these using `applyMomentGraphNamespacePrefix`. By pre-combining them in the link, we were causing the prefix to be applied twice (e.g., `sim:sim:moment-graph-v2`).

## Directory & File Structure
```text
src/app/
└── pages/audit/subpages/
    └── [MODIFY] simulation-runs-page.tsx
```

## Suggested Verification (Manual)
1. **Knowledge Graph UI**: Navigate from a simulation run page to "Open in Knowledge Graph".
2. **Success Criteria**: The graph visualization and statistics should load correctly. The "Effective Namespace" shown in the UI should be `prefix:namespace` (e.g. `sim:needle-1`) or just `prefix` if namespace is null.

## Tasks
- [ ] Implement UI fix in `simulation-runs-page.tsx`
- [ ] Verify fix with needle simulation

## Discovered second root cause of blank Knowledge Graph UI
- In addition to double-prefixing, the Knowledge Graph page was overwriting null namespaces with the engine default (e.g., 'main').
- Combined with a prefix like 'sim', this resulted in 'sim:main' instead of 'sim:'.
- We will fix the page initialization to respect intentional nulls when a prefix is present.

### Revised Work Task Blueprint
# Resolve Knowledge Graph UI Blankness (Part 2)

## Context
The Knowledge Graph UI remains blank because the page incorrectly overwrites empty/null namespaces with the default system namespace (e.g., `main`) even when a prefix (e.g., `sim`) is provided. This leads to queries against `sim:main` instead of the expected `sim:`.

## Proposed Changes

### Knowledge Graph UI Fix
#### [MODIFY] [knowledge-graph-page.tsx](file:///Users/justin/rw/worktrees/machinen_simplify-phase-arch/src/app/pages/audit/subpages/knowledge-graph-page.tsx)
*   **Fix**: Update the `fetchNamespace` effect to NOT fetch the default namespace if the URL already provides a `prefix` (or `namespacePrefix`).
*   **Rationale**: If a prefix is present, we are likely in a simulation context where a null base namespace is intentional and signifies the root of that prefix.

### Simulation Runs Link Improvement
#### [MODIFY] [simulation-runs-page.tsx](file:///Users/justin/rw/worktrees/machinen_simplify-phase-arch/src/app/pages/audit/subpages/simulation-runs-page.tsx)
*   **Fix**: Ensure `namespace` parameter is explicitly set to an empty string if `baseNs` is null, to signal intent to the page. (Optional but good for clarity).

## Directory & File Structure
```text
src/app/
└── pages/audit/subpages/
    ├── [MODIFY] knowledge-graph-page.tsx
    └── [MODIFY] simulation-runs-page.tsx
```

## Suggested Verification (Manual)
1. **Knowledge Graph UI**: Navigate from a simulation run page to "Open in Knowledge Graph".
2. **Success Criteria**: The "Effective Namespace" should be correctly resolved (e.g. `sim:` or `sim:needle-1`) and data should load.

## Tasks
- [/] Draft revised fix for Knowledge Graph UI
- [ ] Implement `knowledge-graph-page.tsx` fix
- [ ] Implement `simulation-runs-page.tsx` enhancement
- [ ] Verify fix with needle simulation
## Investigating Knowledge Graph Namespace Mismatch
- The Knowledge Graph UI for simulations is querying `prefix:redwood:rwsdk` but moments exist at `prefix`.
- We need to determine if `redwoodScopeRouterPlugin` should be active during simulation indexing or if the UI should skip default scoping when a prefix is present.
- The user suggests this is related to how we apply namespaces via the router.
## Resolving Scoped Simulation Namespaces
- Discovered that simulation moments are missing scoping (e.g. `redwood:rwsdk`) leading to blank UI.
- Decided to resolve scoping in `ingest_diff` and persist in `simulation_run_artifacts`.
- The `simulation-worker` will fetch this scoping info to initialize the `PipelineContext` for all phases.

## Work Task Blueprint: Scoped Simulation Namespaces

### Context
Moments in simulations are currently written to the root simulation namespace (e.g., `local-2026-02-04...`), causing them to be invisible to the Knowledge Graph UI which expects scoped namespaces (e.g., `local-...:redwood:rwsdk`). We need to resolve and persist document-specific scoping during the simulation without adding new columns to legacy-tracking tables.

### Breakdown of Planned Changes

#### Ingest Diff Phase
* **Modify `src/app/pipelines/ingest_diff/index.ts`**: 
    - Update output type to include `baseNamespace: string | null`.
* **Modify `src/app/pipelines/ingest_diff/engine/core/orchestrator.ts`**: 
    - Use `prepareDocumentForR2Key` and `computeMomentGraphNamespaceForIndexing` to resolve the document-specific scope.
    - Return this scope as `baseNamespace` in the phase output. This will be automatically persisted to the `simulation_run_artifacts` table by the runtime.

#### Simulation Runtime
* **Modify `src/app/engine/services/simulation-worker.ts`**:
    - When initializing `PipelineContext` for any phase job:
        1. Attempt to load the `ingest_diff` artifact for the current `r2Key`.
        2. If found, extract the `baseNamespace`.
        3. Apply the simulation's prefix to this base to form the `effectiveNamespace`.
    - This ensures that subsequent phases like `materialize_moments` use the correct scoped namespace for writing data.

### Directory & File Structure
```text
src/app/
├── engine/
│   └── services/
│       └── [MODIFY] simulation-worker.ts
└── pipelines/
    └── ingest_diff/
        ├── [MODIFY] index.ts
        └── engine/core/
            └── [MODIFY] orchestrator.ts
```

### Types & Data Structures
* **IngestDiffOutput**:
```typescript
{
  etag: string;
  changed: boolean;
  baseNamespace: string | null;
}
```

### Invariants & Constraints
* **Side-Effect Free Context**: Scoping resolution must happen within the phase logic and be persisted as an artifact.
* **No Table Mutations**: Do not add columns to `simulation_run_documents`.
* **Standard Scoping**: Use `redwoodScopeRouterPlugin` (via `computeMomentGraphNamespaceForIndexing`) to maintain parity with live indexing.

### Suggested Verification (Manual)
1. Trigger a simulation and observe logs in `simulation-worker`.
2. Confirm `materialize_moments` uses the scoped namespace (`prefix:redwood:...`).
3. Verify Knowledge Graph UI is no longer blank for the simulation run.

### Tasks
- [ ] Implement scoping resolution in `ingest_diff` phase
- [ ] Update `simulation-worker.ts` to fetch and apply scoping from artifacts
- [ ] Verify fix with needle simulation


## Revised Work Task Blueprint: Scoped Simulation & Unified UI

### Context
Investigated the implications of per-document scoping for the simulation.
- **Subsequent Phases**: `fetchMomentsFromRun` already queries multiple namespaces if they are recorded in `simulation_run_participating_namespaces`.
- **Knowledge Graph UI**: Currently only views one namespace. If a simulation is split across namespaces, the KG is fragmented.

### Solution
1. **Record Participating Namespaces**: Update `simulation-worker` to register the resolved namespace for each document in the run.
2. **Unified Visualization**: Update the Knowledge Graph server actions to aggregate results from all participating namespaces if a `runId` is provided.

This handles namespaces "under the hood," so the user doesn't need to manually manage them, but the system preserves the strict scoping required by the `MomentGraph` architecture.

### Tasks
- [ ] Implement scoping resolution in `ingest_diff` phase
- [ ] Create `registerParticipatingNamespace` helper
- [ ] Update `simulation-worker.ts` to apply scoping and record participating namespaces
- [ ] Update Knowledge Graph server actions to aggregate by `runId`
- [ ] Verify unified visualization in the KG UI


## Final Work Task Blueprint: Isolation-First Scoped Simulation

### Context
Pivoted the plan to strictly maintain project-level isolation within simulation runs.
- Moments will be written to `prefix:projectNamespace` (e.g., `local-...:redwood:rwsdk`).
- No unified visualization or aggregation will be performed.
- The Knowledge Graph UI selector will be used to view individual projects within a simulation.

### Solution
1. **Resolve Scope**: Resolve `baseNamespace` during `ingest_diff` and persist it in the artifact.
2. **Apply Scope**: `simulation-worker` will apply this scope to the `PipelineContext` for all phases.
3. **Record Participation**: Record namespaces in `simulation_run_participating_namespaces` for internal engine routing efficiency.

### Tasks
- [ ] Implement scoping resolution in `ingest_diff` phase
- [ ] Create `registerParticipatingNamespace` helper
- [ ] Update `simulation-worker.ts` to apply scoping and record participating namespaces
- [ ] Verify fix with needle simulation


## Work Task Blueprint: Scoped Simulation Namespaces (Isolation-First)

### Context
**The Problem**: Moments generated during simulations currently default to the root simulation namespace (`local-2026-02-04-...`). When a user selects a specific project in the Knowledge Graph UI (e.g., `redwood:rwsdk`), these moments are invisible because the UI filters for `local-...:redwood:rwsdk`. This breaks the expectation of viewing project-specific history.

**The Solution**: We will resolve the project scope during the initial `ingest_diff` phase and persist it in the artifact storage. Subsequent phases will load this scope to ensure all moments for a document are written to the correctly qualified namespace.

**Approach**: We will leverage the existing `redwoodScopeRouterPlugin` via the `ingest_diff` orchestrator to perform per-document routing, maintaining strict project isolation.

### Breakdown of Planned Changes

#### 1. Ingest Diff Phase (Resolution)
* **[MODIFY] `src/app/pipelines/ingest_diff/index.ts`**: 
    - Update the phase output type to include `baseNamespace`.
* **[MODIFY] `src/app/pipelines/ingest_diff/engine/core/orchestrator.ts`**: 
    - Implement the call to `computeMomentGraphNamespaceForIndexing`. This involves preparing the document (fetching metadata/headers) to satisfy the router's requirements.

#### 2. Simulation Worker (Propagation)
* **[MODIFY] `src/app/engine/services/simulation-worker.ts`**:
    - Before executing any phase job:
        1. Load the `ingest_diff` artifact for the current document (`r2Key`).
        2. Resolve the `effectiveNamespace` by combining the simulation prefix with the artifact's `baseNamespace`.
        3. Register the namespace as a "participating" namespace for the run.
        4. Inject the `effectiveNamespace` into the `PipelineContext`.

#### 3. Run Persistence (Helpers)
* **[NEW] `src/app/engine/simulation/runNamespaces.ts`**:
    - Add `registerParticipatingNamespace(runId, namespace)` to track which project namespaces are active in a simulation run.

### Directory & File Structure
```text
src/app/
├── engine/
│   ├── services/
│   │   └── [MODIFY] simulation-worker.ts
│   └── simulation/
│       └── [NEW] runNamespaces.ts
└── pipelines/
    └── ingest_diff/
        ├── [MODIFY] index.ts
        └── engine/core/
            └── [MODIFY] orchestrator.ts
```

### Types & Data Structures

**Ingest Diff Output**:
```typescript
export interface IngestDiffOutput {
  etag: string;
  changed: boolean;
  baseNamespace: string | null;
}
```

### Invariants & Constraints
- **Project Isolation**: A document belonging to `rwsdk` must never have its moments written to the `machinen` namespace.
- **Artifact-Driven State**: The `simulation_run_documents` table remains a control-flow table only. Artifact-specific metadata must live in `simulation_run_artifacts`.

### System Flow (Snapshot Diff)

**Previous Flow**:
1. `ingest_diff` returns `{ etag, changed }`.
2. `simulation-worker` initializes `PipelineContext` with the run's default prefix.
3. `materialize_moments` writes to `local-date-prefix`.
4. KG UI filters for `local-date-prefix:redwood:rwsdk` -> **No results**.

**New Flow**:
1. `ingest_diff` returns `{ etag, changed, baseNamespace: 'redwood:rwsdk' }`.
2. `simulation-worker` loads artifact -> sets `context.momentGraphNamespace = 'local-date-prefix:redwood:rwsdk'`.
3. `materialize_moments` writes to `local-date-prefix:redwood:rwsdk`.
4. KG UI filters for `local-date-prefix:redwood:rwsdk` -> **Success**.

### Suggested Verification (Manual)
1. Run a simulation that includes both `rwsdk` and `machinen` files.
2. Select `redwood:rwsdk` in the Knowledge Graph UI for the run.
3. Confirm only `rwsdk` moments appear and are correctly qualified.
4. Verify `simulation_run_participating_namespaces` contains both qualified namespaces.

### Tasks
- [ ] Implement `registerParticipatingNamespace` in `src/app/engine/simulation/runNamespaces.ts`
- [ ] Implement scope resolution in `ingest_diff/engine/core/orchestrator.ts`
- [ ] Update `ingest_diff/index.ts` output type
- [ ] Update `simulation-worker.ts` to propagate namespace from artifacts
- [ ] Verify fix with needle simulation


## Drafted PR Description [2026-02-04]

# Unified Runtime: Merging Live & Simulation Engines

## Problem
Machinen was suffering from a "Two Engine" problem. To optimize for different constraints—latency for Live, throughput for Simulation—we architected two completely separate execution paths.

This schism created a distinct architectural smell: **Permissiveness**.

1.  **The Constraint Failure**: The previous architecture made it *too easy* to implement logic in the wrong place. We found multiple phases where complex business logic existed *only* in the `Simulation Runner`, completely bypassing the shared core.
2.  **The Broken Live Path**: Because logic leaked into the Simulation runners, the "Live" adapters were often empty shells. We discovered that for many phases, the Live implementation *did not actually exist*, meaning the system was incapable of running in production despite passing simulation backtests.
3.  **Logic Drift**: Even where code was shared, the "Runner" layers (error handling, polling, retries) diverged significantly. A successful simulation run was no guarantee of live correctness because the underlying orchestration was fundamentally different.
4.  **Zombie Tasks**: The legacy simulation engine lacked a coherent supervisor. Jobs would fail, retry indefinitely without counting, and thrash the queue—a "distributed infinite loop" that drained resources.

We realized that by allowing the Simulation to be a separate product, we had built a system that was excellent at simulating *itself*, but poor at verifying the production runtime.

## Solution
This change deletes the concept of separate engines. We have introduced a **Unified Runtime** (`src/app/engine/runtime`) that enforces a single code path for all execution.

### 1. The Single Orchestrator
There is now only one entry point: `executePhase`.
It handles the universal lifecycle of every unit of work: `Load -> Execute -> Persist -> Transition`.

We handle environment differences not by forking the code, but by injecting **Strategies**:
*   **Live Mode**: Uses `NoOpStorage` (ephemeral) and `QueueTransition`.
*   **Simulation Mode**: Uses `ArtifactStorage` (persists inputs/outputs to DB) and `QueueTransition` (throttled).

### 2. Stateless Context (Death to "Ports")
We removed the "Ports and Adapters" pattern, which proved to be an abstraction too far. Core business logic now accepts a `PipelineContext`. This context provides a standard set of stateless capabilities (`db`, `vector`, `llm`, `logger`). The logic remains pure-ish (it controls *what* to do), while the Runtime handles the side-effects of *when* to retry or save.

### 3. Infrastructure Isolation
Simulations are no longer "second-class citizens" operating in a shared dump. We enforced strict Infrastructure Isolation:
*   **Scoped Namespaces**: Simulation runs now resolve the project scope (e.g., `redwood:rwsdk`) during Ingestion and strictly enforce this scope for all subsequent writes.
*   **Deterministic Execution**: We purged post-R2 caching layers. If the source code changes, the simulation *must* re-execute the logic, ensuring that we never validate against stale "cached" success.

### 4. The Great Deletion
By unifying the runners, we deleted:
*   **Per-Phase Runners:** 8+ copies of polling loops and error handlers.
*   **The Pipeline Registry:** A redundant map of phase definitions.
*   **Legacy Databases:** The `subjects` database and disjointed `simulation_run_*` tables were replaced by a single `simulation_run_artifacts` store.
*   **R2 Listing Pipeline:** Collapsed entirely into the Simulation Runner as a built-in pre-flight step.

## Verification
This re-architecture was verified by:
1.  **Needle Simulations:** Running end-to-end simulations on specific PRs (`#933`, `#522`) to prove that correct linking, synthesis, and fitting occur under the new runtime.
2.  **Infrastructure Checks:** Verifying that no "zombie" tasks remained in Cloudflare Queues after run failures.
3.  **UI Verification:** Confirming that the Knowledge Graph reflects project-isolated data correctly.

