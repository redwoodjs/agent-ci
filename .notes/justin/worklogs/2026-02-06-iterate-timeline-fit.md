# Overhaul Timeline Fit Phase (Phase 8) 2026-02-06

## Investigated Phase 8 (Timeline Fit) and Stream Continuity
We analyzed the current linking logic in Phase 8 and found it relies too heavily on semantic similarity and shared anchors, often ignoring the intrinsic continuity of the work streams generated in Phase 3. 

Since Phase 3 (Macro Synthesis) already organizes moments into coherent streams, we decided that the source of truth for continuity should be captured during **Phase 5 (Materialize Moments)**. By tracking the predecessor ID during the materialization loop, we can provide Phase 8 with a "Continuity" signal that is 100% reliable.

## Work Task Blueprint: Tiered Evidence Linking

### Context
We are overhauling Phase 8 to move from a vector-heavy ranking to a tiered-evidence approach. This ensures that "Stream of Consciousness" narrative links are prioritized above semantic guesses.

### Breakdown of Planned Changes
- **Phase 5 (Materialize Moments)**: Update logic to track the `predecessorId` within each stream and store it in `sourceMetadata.simulation.predecessorMomentId`.
- **Phase 7 (Candidate Sets)**: Ensure the predecessor moment is explicitly included in the candidate set and tagged with `isPredecessor: true`. Increase candidate limit to 10 for broader context.
- **Phase 8 (Timeline Fit)**:
    - Implement **Blended Ranking**: Continuity (Priority 1) > Blended Search Score (Semantic + Anchors).
    - **Strict Chronological Pre-filtering**: Reject any candidates that are not earlier in time than the child (rejection reason: `time-inversion`) before shortlisting.
    - Refactor from "Veto" to **LLM Selection**: Provide the LLM with top 10 valid candidates to pick the "Logical Continuation".
    - **Prompt Specification**: Explicitly define "Linking" as narrative progression (e.g. Issue -> Investigation -> Fix) and include relative time gaps.
    - Capture LLM reasoning and signal details in the Link Audit Log.

### Directory & File Structure
- [MODIFY] `src/app/pipelines/materialize_moments/engine/core/orchestrator.ts`
- [MODIFY] `src/app/pipelines/candidate_sets/engine/core/orchestrator.ts`
- [MODIFY] `src/app/pipelines/timeline_fit/engine/core/orchestrator.ts`
- [MODIFY] `src/app/pipelines/timeline_fit/index.ts`

### Types & Data Structures
```typescript
export type TimelineFitDecision = {
  candidateId: string;
  score: number | null;
  selected: boolean;
  rejected?: boolean;
  rejectReason?: string;
  rank?: number;
  details?: {
    sharedAnchorTokens: string[];
    isPredecessor?: boolean;
    semanticScore?: number;
    timeDeltaMs?: number;
    reasoning?: string;
  };
};
```

### Invariants & Constraints
- **Invariant**: A moment cannot link to a parent that was created later in time.
- **Constraint**: Continuity links (same stream, sequential) must be the primary signal for ranking.

### System Flow (Snapshot Diff)
**Previous Flow**: Vector/Anchor Search -> Mixed Ranking -> Terse Veto -> Selection.
**New Flow**: Predecessor + Vector/Anchor Search -> **Blended Ranking** (Predecessor > Blended Score) -> **LLM Selection** (10 candidates + definitions + time) -> Selection w/ Evidence.

### Suggested Verification (Manual)
1. Run a simulation using `wrkr sim`.
2. Inspect a moment's `linkAuditLog` to verify the LLM's selection reasoning and the "Continuity/Blended" signals were used correctly.

### Tasks
- [ ] Update `materialize_moments` to capture `predecessorMomentId`
- [ ] Update `candidate_sets` to inject predecessor candidate (limit 10)
- [ ] Refactor Phase 8 orchestrator for blended ranking and LLM selection
- [ ] Update Phase 8 LLM prompt with context and definitions
- [ ] Update artifact storage to capture reasoning and evidence labels
