## Work Task Blueprint: Resolve Linking Failure and Retrieval Stall

### Context
We are resolving why simulation phases ("Candidate Sets," "Timeline Fit") are returning empty results and why deterministic linking fails to connect related documents (e.g., #933 to #522). 

The empty results likely stem from a Vectorize retrieval stall. We will follow [create-indexes.md](file:///Users/justin/rw/worktrees/machinen_simplify-phase-arch/docs/dev-recipes/create-indexes.md) to migrate to v7 indexes.

**Anchor Drift**: Our investigation revealed drift between [chain-aware-moment-linking.md](file:///Users/justin/rw/worktrees/machinen_simplify-phase-arch/docs/architecture/chain-aware-moment-linking.md) and the implementation.
1. The arch doc calls for **explicit anchor matching** in the candidate set phase, but we currently only use vector search.
2. The implementation of `macroSynthesisPromptContext` (crucial for injecting anchors into synthesis) is not yet documented in the blueprints.

Furthermore, we are moving "stream chaining" (linking sequential moments within one document) from `deterministic_linking` to `timeline_fit`. This enables the system to evaluate chronological continuity across the entire graph, rather than forcing a same-document link.

### Breakdown of Planned Changes

#### Core Engine (Vectorize v7 & Anchors)
*   **Modify `src/app/engine/databases/momentGraph/index.ts`**:
    *   Confirm upsert metadata uses the `momentGraphNamespace` key.
    *   [NEW] Add `findMomentsByAnchors` to support explicit anchor retrieval.

#### Candidate Sets (Heuristic Adjustment & Drift Correction)
*   **Modify `src/app/pipelines/candidate_sets/engine/core/orchestrator.ts`**:
    *   [DELETE] same-document filtering logic.
    *   [NEW] Integrate `findMomentsByAnchors` to retrieve candidates by explicit shared tokens (Issue refs, etc), aligning with `chain-aware-moment-linking.md`.
    *   [NEW] Logging for vector vs anchor match counts.

#### Deterministic Linking (Refining Focus)
*   **Modify `src/app/pipelines/deterministic_linking/engine/core/orchestrator.ts`**:
    *   [MODIFY] `computeDeterministicLinkingProposal`: Remove automatic linkage for `macroIndex > 0`.
    *   [NEW] Diagnostic logging in `computeDeterministicLinkingDecision` to trace `#933` -> `#522` resolution.

#### Timeline Fit (Observability)
*   **Modify `src/app/pipelines/timeline_fit/engine/core/orchestrator.ts`**:
    *   [NEW] Logging for chosen parent and shared anchor signals.

#### Documentation (Blueprint Alignment)
*   **Modify `docs/blueprints/runtime-architecture.md`**:
    *   [NEW] Document `macroSynthesisPromptContext` in Phase 3.
    *   [MODIFY] Update Phase 6/7/8 descriptions to reflect the new linking strategy and anchor signals.

### Directory & File Structure
```text
src/app/
├── engine/
│   └── databases/
│       └── momentGraph/
│           └── [MODIFY] index.ts
└── pipelines/
    ├── candidate_sets/
    │   └── engine/core/
    │       └── [MODIFY] orchestrator.ts
    ├── deterministic_linking/
    │   └── engine/core/
    │       └── [MODIFY] orchestrator.ts
    └── timeline_fit/
        └── engine/core/
            └── [MODIFY] orchestrator.ts
docs/blueprints/
└── [MODIFY] runtime-architecture.md
```

### Types & Data Structures
No type changes required.

### Invariants & Constraints
*   **Work Continuity**: `Timeline Fit` must prioritize moments with shared anchors (preserving the "work continuity" principle).
*   **Namespace Isolation**: All Vectorize queries must include the `momentGraphNamespace` metadata filter.

### System Flow (Snapshot Diff)
*   **Previous Flow**: 
    1. `deterministic_linking` automatically chains sequential moments in a document.
    2. `candidate_sets` filters out all same-document moments and only uses vector for retrieval.
    3. Retrieval stalls on stagnant Vectorize v6 indexes.
*   **New Flow**:
    1. `deterministic_linking` only handles explicit references (e.g. "Fixes #123").
    2. `candidate_sets` treats same-document moments as valid candidates and uses BOTH vector + explicit anchor tokens for retrieval.
    3. `timeline_fit` evaluates both stream-chaining and cross-document links based on shared signal.
    4. Retrieval uses fresh Vectorize v7 indexes.

### Suggested Verification (Manual)
1.  User follows [create-indexes.md](file:///Users/justin/rw/worktrees/machinen_simplify-phase-arch/docs/dev-recipes/create-indexes.md) to create and bind v7 indexes.
2.  Trigger a simulation with "needle" documents (#933, #522).
3.  Inspect `simulation_run_events` for `deterministic_linking.log` to see reference resolution trace.
4.  Verify `timeline_fit` now produces links (including stream chain links).

### Tasks
- [ ] Implement Vectorize v7 code points and logging in `momentGraph/index.ts`
- [ ] Implement `findMomentsByAnchors` in `momentGraph/index.ts`
- [ ] Update `candidate_sets` (remove same-doc filter, add anchor search)
- [ ] Refactor `deterministic_linking` and add diagnostic logs
- [ ] Add observability to `timeline_fit`
- [ ] Update `runtime-architecture.md` blueprint
- [ ] Verify fix with simulation (Requires User to run index creation recipe first)

## Work Task Blueprint: Resolve Linking Failure and Retrieval Stall

### Context
We are resolving why simulation phases ("Candidate Sets," "Timeline Fit") are returning empty results and why deterministic linking fails to connect related documents (e.g., #933 to #522). 

The empty results likely stem from a Vectorize retrieval stall. We will follow [create-indexes.md](file:///Users/justin/rw/worktrees/machinen_simplify-phase-arch/docs/dev-recipes/create-indexes.md) to migrate to v7 indexes.

**Anchor Drift**: Our investigation revealed drift between [chain-aware-moment-linking.md](file:///Users/justin/rw/worktrees/machinen_simplify-phase-arch/docs/architecture/chain-aware-moment-linking.md) and the implementation.
1. The arch doc calls for **explicit anchor matching** in the candidate set phase, but we currently only use vector search.
2. The implementation of `macroSynthesisPromptContext` (crucial for injecting anchors into synthesis) is not yet documented in the blueprints.

Furthermore, we are moving "stream chaining" (linking sequential moments within one document) from `deterministic_linking` to `timeline_fit`. This enables the system to evaluate chronological continuity across the entire graph, rather than forcing a same-document link.

### Breakdown of Planned Changes

#### Core Engine (Vectorize v7 & SQLite Anchors)
*   [NEW] Modify `src/app/engine/databases/momentGraph/migrations.ts` to add `moment_anchors` table.
*   [MODIFY] Modify `src/app/engine/databases/momentGraph/index.ts`:
    *   `addMoment`: Persist `moment.anchors` to `moment_anchors` table.
    *   [NEW] Add `findMomentsByAnchors` for SQLite-based anchor retrieval.
*   [MODIFY] Confirm Vectorize upsert/query metadata uses the `momentGraphNamespace` key.

#### Candidate Sets (Heuristic Adjustment & Drift Correction)
*   [MODIFY] Modify `src/app/pipelines/candidate_sets/engine/core/orchestrator.ts`:
    *   [DELETE] same-document filtering logic.
    *   [MODIFY] `runCandidateSetComputation`: Integrate `findMomentsByAnchors` (SQLite) alongside Vector search.
    *   [NEW] Logging for vector vs anchor match counts.

#### Deterministic Linking (Refining Focus)
*   [MODIFY] Modify `src/app/pipelines/deterministic_linking/engine/core/orchestrator.ts`:
    *   [MODIFY] `computeDeterministicLinkingProposal`: Remove automatic linkage for `macroIndex > 0`.
    *   [NEW] Diagnostic logging in `computeDeterministicLinkingDecision` to trace `#933` -> `#522` resolution.

#### Timeline Fit (Observability)
*   [MODIFY] Modify `src/app/pipelines/timeline_fit/engine/core/orchestrator.ts`:
    *   [NEW] Logging for chosen parent and shared anchor signals.

#### Documentation (Blueprint Alignment)
*   [MODIFY] Modify `docs/blueprints/runtime-architecture.md`:
    *   [NEW] Document `macroSynthesisPromptContext` in Phase 3.
    *   [MODIFY] Update Phase 6/7/8 descriptions to reflect the hybrid retrieval strategy.

### Directory & File Structure
```text
src/app/
├── engine/
│   └── databases/
│       └── momentGraph/
│           ├── [MODIFY] index.ts
│           └── [MODIFY] migrations.ts
└── pipelines/
    ├── candidate_sets/
    │   └── engine/core/
    │       └── [MODIFY] orchestrator.ts
    ├── deterministic_linking/
    │   └── engine/core/
    │       └── [MODIFY] orchestrator.ts
    └── timeline_fit/
        └── engine/core/
            └── [MODIFY] orchestrator.ts
docs/blueprints/
└── [MODIFY] runtime-architecture.md
```

### Types & Data Structures
No changes to public interface of `Moment` type, but we will utilize the existing `anchors` field.

### Invariants & Constraints
*   **Work Continuity**: `Timeline Fit` must prioritize moments with shared anchors (preserving the "work continuity" principle).
*   **Namespace Isolation**: All Vectorize and SQLite queries must be scoped to the `momentGraphNamespace`.

### System Flow (Snapshot Diff)
*   **Previous Flow**: 
    1. `deterministic_linking` automatically chains sequential moments in a document.
    2. `candidate_sets` filters out all same-document moments and only uses vector for retrieval.
    3. Anchors are extracted but immediately discarded.
*   **New Flow**:
    1. `deterministic_linking` only handles explicit references (e.g. "Fixes #123").
    2. `candidate_sets` treats same-document moments as valid candidates.
    3. **Hybrid Retrieval**: `candidate_sets` queries fresh Vectorize v7 (Semantic) AND SQLite `moment_anchors` (Explicit).
    4. `timeline_fit` evaluates both stream-chaining and cross-document links based on shared signal.

### Suggested Verification (Manual)
1.  User follows [create-indexes.md](file:///Users/justin/rw/worktrees/machinen_simplify-phase-arch/docs/dev-recipes/create-indexes.md) to create and bind v7 indexes.
2.  Trigger a simulation with "needle" documents (#933, #522).
3.  Inspect `simulation_run_events` for `deterministic_linking.log` to see reference resolution trace.
4.  Verify `timeline_fit` now produces links (including stream chain links).

### Tasks
- [ ] Implement SQLite migration for `moment_anchors`
- [ ] Implement Vectorize v7 code points and logging in `momentGraph/index.ts`
- [ ] Update `addMoment` to persist anchors in SQLite
- [ ] Implement `findMomentsByAnchors` in `momentGraph/index.ts`
- [ ] Update `candidate_sets` (remove same-doc filter, add anchor search)
- [ ] Refactor `deterministic_linking` and add diagnostic logs
- [ ] Add observability to `timeline_fit`
- [ ] Update `runtime-architecture.md` blueprint
- [ ] Verify fix with simulation (Requires User to run index creation recipe first)

## Work Task Blueprint: Resolve Linking Failure, Retrieval Stall, and UI Discrepancy

### Context
We are resolving three interrelated issues discovered during needle simulation runs:
1. **Retrieval Stall**: Vectorize v7 indexes appear stagnant. We rotated to **v8**.
2. **Deterministic Linking Failure**: The reference from #933 to #522 is missed because it resides in the raw document body but wasn't synthesized into the moment's summary.
3. **Timeline Fit UI Bug**: The UI displays "Rejected / No Fit" even when a parent is successfully chosen, because the `outcome` field is missing from the orchestrator's output.

### Breakdown of Planned Changes

#### Core Engine (Vectorize v8 & Metadata Indexes)
*   **Rotation**: Updated `wrangler.jsonc` to point to `moment-index-v8`, `subject-index-v8`, and `rag-index-v8`.
*   **Binding**: Added missing `SUBJECT_INDEX` binding.

#### Deterministic Linking (Full Doc Scan Fallback)
*   **Modify `src/app/pipelines/deterministic_linking/engine/core/orchestrator.ts`**:
    *   If moment anchors fail to find a reference, fetch the raw source document from R2 (via `r2Key`).
    *   Scan the raw text for explicit references like `#522` using regex.
    *   [NEW] Logging for R2 fetch and extraction.

#### Timeline Fit (UI & Logic Alignment)
*   **Modify `src/app/pipelines/timeline_fit/engine/core/orchestrator.ts`**:
    *   [NEW] Add `outcome` property to the return object: "fit" if `chosenParentId` is set, otherwise "no-fit".
    *   [NEW] Ensure diagnostic logs reflect the chosen outcome.

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
└── [MODIFY] wrangler.jsonc
```

### Types & Data Structures
No breaking changes to public types.

### Invariants & Constraints
*   **Source Truth**: Deterministic linking should prioritize explicit references in the raw document over synthesized summaries.
*   **UI Consistency**: The `outcome` field must accurately reflect the `chosenParentId` state.

### System Flow (Snapshot Diff)
*   **Previous Flow**: 
    1. Deterministic linking only scans moment title/summary.
    2. Timeline fit returns `chosenParentId` but omits `outcome`.
*   **New Flow**:
    1. Deterministic linking fallbacks to raw R2 content scan.
    2. Timeline fit explicitly sets `outcome: "fit"` on success.

### Tasks
- [x] Rotate to Vectorize v8 indexes
- [ ] Implement raw doc scan fallback in `deterministic_linking`
- [ ] Fix missing `outcome` in `timeline_fit`
- [ ] Verify fix with needle simulation

