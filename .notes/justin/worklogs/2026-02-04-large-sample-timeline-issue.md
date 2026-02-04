# Large Sample Timeline Issue 2026-02-04

## Investigated "Untitled" entries and llm-veto-fail errors
We conducted a thorough investigation into the "Untitled" entries appearing in large sample simulations and the companion `llm-veto-fail` errors.

### Evidence & Findings
1.  **Systemic Fetch failure in `fetchMomentsFromRun`**: The simulation UI depends on `fetchMomentsFromRun` to map IDs to titles. This uses SQL `IN` clauses against relational tables. Large samples hit parameter limits (e.g. 1000+ IDs).
2.  **The "JSON Blob" Way Out (Artifact Enrichment)**: We will adopt a self-contained artifact pattern. Execution workers (which process one document at a time) will enrich their output artifacts with the necessary metadata (titles/summaries) during decision creation. This renders the UI worker's relational `IN` clause obsolete.
3.  **Memory Safety & Performance**:
    - **Execution**: Safe. Workers fetch titles in small, bounded batches (100) and process one document at a time.
    - **UI Worker**: Faster & Leaner. It no longer needs to query the DB for details or build an in-memory join map. It simply parses the already-loaded artifact blobs. This is a net memory win for the 128MB/256MB environment.
4.  **Uninitialized Context in Workers**: `simulation-worker.ts` and `indexing-scheduler-worker.ts` are missing service initializations.
5.  **Synthesis Token Limits**: Phase 3 is limited to 2000 tokens, which causes truncation on large documents.

## Revised Work Task Blueprint

### Context
Simulation UIs for Linking and Timeline Fit currently resolved moment details (titles/summaries) via relational DB lookups using SQL `IN` clauses. On large simulations, these clauses hit SQLite parameter limits, resulting in empty metadata and "Untitled" UI fallbacks. We are adopting an **Artifact Enrichment** strategy where simulation phases enrich their own output artifacts with the necessary metadata during execution, making them self-contained JSON blobs.

### Proposed Changes

#### Simulation Phase Enrichment
- **Phase 7 (Linking)**: Update `runDeterministicLinkingForDocument` to fetch and store titles for resolved parents.
- **Phase 8 (Timeline Fit)**: Update `runTimelineFitForDocument` to fetch and store metadata for chosen parents and top candidates.
- **Phase 9 (Candidate Sets)**: Update `runCandidateSetComputation` to include child moment metadata in the output.

#### Infrastructure & Logic
- **Phase 3 (Synthesis)**: Increase `max_tokens` to 4000 in `synthesizeMicroMoments.ts` to avoid truncated macro-moment descriptions.
- **UI Data Layer**: Update `runArtifacts.ts` to prefer enriched metadata from artifacts, bypassing relational lookups.

### Tasks
- [ ] Enrich Deterministic Linking artifacts
- [ ] Enrich Candidate Set artifacts
- [ ] Enrich Timeline Fit artifacts
- [ ] Scale Phase 3 Synthesis tokens
- [ ] Update `runArtifacts.ts` UI fetch logic

## Implemented Artifact Enrichment Strategy

### Changes Summary
- **Phase 7 (Linking)**: Modified `runDeterministicLinkingForDocument` to batch-fetch parent titles and include them in the `decisions` array.
- **Phase 9 (Candidate Sets)**: Updated `runCandidateSetComputation` to include `childTitle` and `childSummary` in the set owner's metadata.
- **Phase 8 (Timeline Fit)**: Enriched `TimelineFitDecision` with candidate titles/summaries and updated the final output to include `chosenParentTitle/Summary`.
- **Phase 3 (Synthesis)**: Increased `max_tokens` to 4000 in `synthesizeMicroMoments.ts` to accommodate large document descriptions without truncation.
- **UI Data Layer**: Updated `runArtifacts.ts` (`getSimulationRunLinkDecisions`, `getSimulationRunCandidateSets`, `getSimulationRunTimelineFitDecisions`) to prefer data from JSON artifacts. This minimizes relational `IN` clause usage, preventing parameter limit errors on large runs.

### Technical Detail
Enrichment happens during simulation execution (one document at a time), which is memory-efficient. The UI worker now saves memory by skipping the secondary relational join.
