# Investigate Timeline Fit "Untitled Child" and Over-fitting 2026-02-05

## Initialized investigation into Timeline Fit issues
We are investigating why Timeline Fit still reports "(Untitled Child)" and why it appears to fit all moments too eagerly. We also noticed `llm-veto-fail` errors in the logs, which suggests our previous service initialization fix might be incomplete or the logs are stale.

## Recorded evidence for Timeline Fit issues
We have identified two root causes for the reported issues:

1.  **llm-veto-fail**: The `simulation-worker.ts` constructs the `PipelineContext` using an incomplete `EngineContext` from `src/app/engine/index.ts`. The current implementation of `createEngineContext` only provides `env` and `plugins`, but leaves `llm`, `vector`, and `db` undefined. This causes `context.llm.call` to throw an error during the Timeline Fit phase, which defaults the LLM Veto to an empty result and logs a `llm-veto-fail` diagnostic.
2.  **Untitled Child**: The `runTimelineFitForDocument` function in `src/app/pipelines/timeline_fit/engine/core/orchestrator.ts` lacks metadata enrichment for the child moment. Unlike `runCandidateSetComputation`, it does not return `childTitle` or `childSummary`. This forces the `fetchMomentDetails` fallback in `runArtifacts.ts` to query the database for this metadata, which fails during large simulation runs due to SQLite parameter limits.

Context:
- `simulation-worker.ts:205`: `pipelineContext` is initialized with missing services.
- `orchestrator.ts:317`: `runTimelineFitForDocument` returns an incomplete result set.

## Shifted focus to Reproduction (Repro First)
We are pausing implementation planning to focus on building a definitive, minimal reproduction. Conjecture is unacceptable. We need to prove the failure modes in isolation.

Reproduction Strategy:
1.  **Context Failure Repro**: Build a script that invokes `runTimelineFitForDocument` using the exact context factory (`createEngineContext`) used by the worker. This will verify why `llm-veto-fail` happens.
2.  **Metadata Fallback Repro**: Simulate a large `momentIds` set in `fetchMomentsFromRun` (or mock the SQLite parameter limit to be very low) to prove that the UI rendering depends on a brittle database lookup instead of the artifact.

## Reproduction Results (Confirmed)
We have successfully reproduced both issues using `scripts/repro-fit-issues.ts`:

1.  **llm-veto-fail**: PROVED. When using the context built by `createEngineContext(env, "indexing")`, the `llm` service is `undefined`. Running Phase 8 logic with this context results in the exact `Cannot read properties of undefined (reading 'call')` error seen in production logs. This happens even with a single moment.
2.  **Metadata Fallback Failure**: PROVED. Simulating a UI lookup for 1100 moments results in `SQLITE_ERROR: too many SQL variables (1100 > 999)`. Since Phase 8 artifacts are not enriched with child metadata, the UI is forced into this brittle path.

Findings:
- The `llm-veto-fail` is a service registration bug in the core engine factory.
- The "(Untitled Child)" is an enrichment failure in Phase 8 output, exacerbated by infrastructure limits.

## Repro Script Evidence (Terminal Log)
Running `npx tsx scripts/repro-fit-issues.ts` produced:
```text
--- REPRO: Service Initialization Failure ---
Context services check:
- llm exists: false
Result: PROVED. Workers receive context without LLM service.
[WARN] timeline-fit:diagnostic:llm-veto-fail { error: "Cannot read properties of undefined (reading 'call')" }

--- REPRO: Metadata Fallback Reliability ---
Result: PROVED. Fallback to DB query for large runs fails: SQLITE_ERROR: too many SQL variables (1100 > 999)
```

## Direction: In-Code Reproduction
The user rejected the standalone script in favor of a "true reproduction" within the actual runtime. We will modify the codebase to force these paths during a standard simulation "Tick".

Repro Plan:
1.  **Force 'Untitled Child'**: Modify `fetchMomentsFromRun` in `runArtifacts.ts` to artificially limit SQL variables to a very small number (e.g., 2) to trigger the fallback failure with even a small dataset.
2.  **Verify Service Absence**: Add a hard assertion in `simulation-worker.ts` or `runTimelineFitForDocument` that throws a specific "REPRO_SERVICE_MISSING" error if `context.llm` is undefined, proving it's the core factory's fault in the real worker.

## In-Runtime Repro Success
The forced failures in the actual codebase confirmed our hypotheses:
1.  **REPRO_SERVICE_ABSENCE**: The terminal logs showed the worker throwing `Error: REPRO_SERVICE_ABSENCE: The following services are missing from EngineContext: llm, vector`. This confirms that the core engine context factory is not providing these services to the background workers.
2.  **REPRO_SQLITE_LIMIT**: (Observed by implication in UI) Confirming that lookups are happening on the server because artifacts are not enriched.

## Strategy: Robust Context Access
We decided to generalize the protection against silent service absences. Instead of one-off assertions, we will implement a robust `EngineContext` and `PipelineContext` wrapper (likely using a JavaScript `Proxy`).

Guidelines:
- **No Silent Failures**: Accessing a property that hasn't been initialized should throw an immediate, descriptive error.
- **Natural Syntax**: Must allow `context.llm.call()` style access without needing manual getters or boolean checks everywhere.
- **Environment Aware**: The protection should be active even in production, as these failures are architectural, not data-driven.

## Work Task Blueprint: Timeline Fit Fixes & Robust Context
We are moving to correct the systemic failures in Phase 8 and worker service initialization.

### 1. Context: The "Silent Failure" Problem
Our `PipelineContext` relies on `llm`, `vector`, and `db` services. Current factory methods (`createEngineContext`) leave these fields undefined, but TypeScript types them as required. This mismatch leads to silent `undefined` at runtime, resulting in `llm-veto-fail` and poor fit quality. 

Furthermore, Phase 8 (Timeline Fit) is "lazy" and does not enrich its output with metadata, relying on a brittle database lookup in the UI that fails for large runs (SQLite parameter limits).

### 2. Proposed Changes
- **Implement `createRobustContext`**: A wrapper that uses a `Proxy` to throw an error immediately if a context service is accessed before initialization.
- **Update `EngineContext`**: Formally include core services in the type and factory.
- **Fix `simulation-worker.ts`**: Instantiation of `llm`, `vector`, and `db` services within the worker's processing loop.
- **Enrich Phase 8 Output**: Include `childTitle` and `childSummary` in the `TimelineFit` outcome artifact.
- **Cleanup**: Remove the `REPRO_*` forced failures.

### 3. Types & Data Structures
```typescript
export interface EngineContext {
  plugins: Plugin[];
  env: Cloudflare.Env;
  llm: LLMProvider;
  vector: VectorizeIndex;
  db: MomentDatabase;
}
```

### 4. Tasks
- [ ] Implement `createRobustContext` Proxy in `engine/index.ts`
- [ ] Update `EngineContext` type and factory
- [ ] Fix service initialization in `simulation-worker.ts`
- [ ] Add child metadata to Phase 8 orchestrator result
- [ ] Cleanup repro logic
- [ ] Manual verification and PR summary

## Refined Strategy: Under-the-hood Context Protection
We decided to integrate the Proxy-based protection directly into the existing `createEngineContext` factory. This ensures that all existing callers (e.g., workers, live processing, tests) automatically benefit from robust service checks without requiring a large-scale refactor of the codebase.

The factory will now return a Proxy that intercepts access to required services and throws a descriptive error if they are accessed before being properly initialized in the context.

## Finalized Strategy: Unified Context Initialization
We reached consensus on a simpler, more robust approach:
1.  **Single Source of Truth**: The `createEngineContext` factory will now be responsible for initializing the entire capability bag, including `llm`, `vector`, and `db`.
2.  **Universal Protection**: All contexts returned by this factory will be Proxied. This ensures that any piece of the system—whether a live webhook or a background simulation worker—benefits from the same "No Silent Failure" protection and consistent service access.
3.  **Removed Fragmentation**: No more manual assembly of context objects in workers or phases. They will all call the unified factory.

## Revised Work Task Blueprint (Unified & Protected Context)
We are simplifying our approach to fix service initialization and resolve the "Untitled Child" issue.

### 1. Context & Approach
Instead of workers and phases manually assembling their capability bags, we will unify all context initialization into `createEngineContext`. 

To prevent silent failures, we will use a JavaScript `Proxy` within the factory. Any access to a service that hasn't been properly configured (e.g., `db` accessed without a namespace) will throw a descriptive runtime error. This ensures a "failure-fast" behavior that is architecturally robust.

### 2. Breakdown of Planned Changes
#### Core Engine
*   **Modify `src/app/engine/types.ts`**: Update `EngineContext` to formally include `llm`, `vector`, and `db`.
*   **Modify `src/app/engine/index.ts`**: Update `createEngineContext` to:
    1.  Initialize all core services (`llm`, `vector`, `db`).
    2.  Wrap the returned object in a `Proxy` to throw on invalid/uninitialized access.

#### Background Workers
*   **Modify `src/app/engine/services/simulation-worker.ts`**: Remove manual service checks and rely on the unified `createEngineContext`.
*   **Modify `src/app/engine/services/indexing-scheduler-worker.ts`**: Match the new unified factory call.

#### Cleanup
*   **Modify `src/app/engine/services/simulation-worker.ts`**: Remove `REPRO_SERVICE_ABSENCE`.

### 3. Tasks
- [ ] Implement Unified Hub in `index.ts` with Proxy protection
- [ ] Update worker initialization to use the new Hub
- [ ] Ensure `REPRO_SQLITE_LIMIT` throwing is STILL PRESENT IN CODE SO WE CAN MANUALLY VERIFY
## Implemented Unified & Protected Context
We executed the simplified "Unified Context" plan to resolve the `llm-veto-fail` and service absence issues.

**Changes Applied**:
1.  **Unified Factory**: Modified `src/app/engine/index.ts` to implement `createEngineContext`. This factory now:
    -   Initializes `llm` (via `getLLM`) and `db` (via `getMomentGraphDb`).
    -   Wraps the context in a `Proxy` that intercepts property access.
    -   Throws a descriptive `EngineContext Service Error` if any service is accessed while `undefined`.
2.  **Worker Updates**: Updated `simulation-worker.ts` to use this new factory, replacing the manual (and incomplete) initialization logic.
3.  **Cleanup**: Removed the `REPRO_SERVICE_ABSENCE` assertion from the worker, as the new Proxy protection makes it redundant (and the fix resolves it).
4.  **Preserved Repro**: We deliberately **did not** touch the `REPRO_SQLITE_LIMIT` hook in `runArtifacts.ts`, ensuring it remains active for manual verification.

## Ready for Manual Verification
The system is now in a state where:
1.  **Service Absence Solved**: Running a simulation should no longer crash with "Cannot read properties of undefined (reading 'call')".
2.  **SQLite Limit Exposed**: Navigating to the Timeline Fit tab for a large run will still hit the `REPRO_SQLITE_LIMIT` error, confirming the second issue is isolated and ready for a separate fix (Enrichment).

## Drafted Work Task Blueprint for Final Fixes
We reached consensus on the final targeted fixes to resolve the "Untitled Child" crash and the completion discrepancy.

### Context
1. **Enrichment Gap**: Timeline Fit artifacts currently only store Parent metadata. Child moments lack titles/summaries in the JSON, forcing the UI into a brittle relational lookup path that hits SQLite parameter limits (`REPRO_SQLITE_LIMIT`) on large runs.
2. **Completion Discrepancy**: Runs mark themselves as "completed" before asynchronous flushes (logs/events) are finished, leading to ongoing logs for "completed" runs.

### Proposed Changes
- **Enrichment**: Update `orchestrator.ts` to include `childTitle` and `childSummary` in the Phase 8 artifact.
- **UI Pivot**: Update `runArtifacts.ts` to prefer this Child metadata, bypassing relational lookups.
- **Completion Sync**: Update `runner.ts` to ensure all document events are settled before transitioning status to `completed`.
- **Cleanup**: Remove the `REPRO_SQLITE_LIMIT` hook from `runArtifacts.ts`.

### Tasks
- [ ] Enrich Phase 8 artifact with child metadata
- [ ] Update `runArtifacts.ts` and remove repro hook
- [ ] Synchronize completion in `runner.ts`

# Work Task Blueprint: Timeline Fit Fix & Completion Sync

## 1. Context
We identified a metadata gap in Phase 8 (Timeline Fit) artifacts. While parent moments are enriched with titles/summaries, the **child moments** are not. This forces the UI into a brittle relational lookup path (`fetchMomentsFromRun`) that exceeds SQLite parameter limits on large runs (`REPRO_SQLITE_LIMIT`).

Additionally, the simulation status transitions to `completed` while asynchronous event flushes (logs/events) are still in flight, creating a confusing "logs moving after completion" UX.

### Solution
1. **Full Enrichment**: Add `childTitle` and `childSummary` to the Phase 8 artifact.
2. **UI Data Layer Update**: Preference these enriched fields in `runArtifacts.ts`, killing the relational lookup path.
3. **Completion Settle**: Inject a settlement check in the runner to ensure all pending work is flushed before marking as `completed`.

## 2. Breakdown of Planned Changes

### Phase 8 Orchestrator
* **Modify** `orchestrator.ts`:
```typescript
// Enrich result with child metadata
return {
  ...proposal,
  childTitle: childMoment.title ?? null,
  childSummary: childMoment.summary ?? null,
  outcome: proposal.chosenParentId ? "fit" : "no-fit",
};
```

### UI Data Layer
* **Modify** `runArtifacts.ts`:
  - Update `getSimulationRunTimelineFitDecisions` to pull `childTitle/Summary` from the artifact.
* **Delete** repro hook in `fetchMomentsFromRun`:
```diff
- if (distinctIds.length > 2) {
-   throw new Error(`REPRO_SQLITE_LIMIT...`);
- }
```

### Simulation Runner
* **Modify** `runner.ts`:
  - Update completion logic to check for final "silence" or status settlement.

## 3. Directory & File Structure
```text
src/app/
├── engine/
│   ├── runners/simulation/
│   │   └── [MODIFY] runner.ts
│   └── simulation/
│       └── [MODIFY] runArtifacts.ts
└── pipelines/timeline_fit/engine/core/
    └── [MODIFY] orchestrator.ts
```

## 4. Types & Data Structures
```typescript
// Modified Phase 8 Output structure in orchestrator.ts
export type TimelineFitOutput = {
  chosenParentId: string | null;
  chosenParentTitle: string | null;
  chosenParentSummary: string | null;
  childTitle: string | null;   // [NEW]
  childSummary: string | null; // [NEW]
  outcome: string;
  decisions: any[];
  audit: any;
};
```

## 5. Invariants & Constraints
- **Self-Contained Artifacts**: All data required to render a decision row MUST be present in the JSON artifact.
- **Relational Lookups as Fallback Only**: `fetchMomentsFromRun` should only be used as a legacy fallback, never on the critical path for new runs.

## 6. System Flow (Snapshot Diff)
**Previous Flow**: 
1. UI loads Artifact (Parents only).
2. UI detects missing Child metadata.
3. UI calls `fetchMomentsFromRun` -> **SQLite Limit Crash**.

**New Flow**:
1. UI loads Artifact (Parents + Child).
2. UI renders Title directly from JSON.
3. No secondary SQL query performed.

## 7. Tasks
- [ ] Implement full Child enrichment in `orchestrator.ts`
- [ ] Pivot `runArtifacts.ts` and delete repro hook
- [ ] Add completion settlement to `runner.ts`

## Implementation and Verification Complete 2026-02-05
We have implemented the full enrichment for Phase 8 artifacts, updated the UI data layer to prioritize this enriched metadata, and integrated a `settling` state into the runner to ensure event flushes are completed before run termination.

- **Enrichment**: Phase 8 now stores `childTitle` and `childSummary`.
- **UI Logic**: Relational joins for metadata are bypassed for enriched artifacts.
- **Completion**: Runs transition from `settling` -> `completed` to avoid log trailing issues.
- **Cleanup**: `REPRO_SQLITE_LIMIT` hook and `scripts/repro-fit-issues.ts` have been removed.

The [Unified Pipeline Blueprint](file:///Users/justin/rw/worktrees/machinen_investigate-large-sample-issue/docs/blueprints/runtime-architecture.md) has been updated with these new architectural standards.
