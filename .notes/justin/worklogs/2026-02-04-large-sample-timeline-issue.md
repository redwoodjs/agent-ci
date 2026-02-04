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

## PR Description

### Title
Adopt Artifact Enrichment for Large Scale Simulations

### Description
#### Problem
Large-scale simulations (e.g., 1000+ moments) were frequently encountering "Untitled" entries in the UI for Linking and Timeline Fit phases. This was caused by a relational database bottleneck: the UI data layer used SQL `IN` clauses to resolve moment IDs to metadata across namespaces. These lists eventually exceeded SQLite parameter limits, leading to empty results and UI fallbacks. Additionally, Phase 3 synthesis was frequently truncating macro-moment descriptions due to a 2000-token limit.

#### Solution
We have adopted an **Artifact Enrichment** strategy that prioritizes self-contained JSON artifacts over render-time relational lookups. 

1. **Phase Enrichment**: Orchestrators for Linking, Candidate Sets, and Timeline Fit now fetch and bake titles and summaries directly into their output JSON artifacts during execution.
2. **UI Data Layer Pivot**: The simulation data fetchers in `runArtifacts.ts` now prefer these enriched fields, bypassing relational DB lookups and their associated parameter limits.
3. **Synthesis Optimization**: Increased the LLM response limit for Phase 3 to 4000 tokens to ensure complete macro-moment generation for dense documents.

This approach results in a more robust and memory-efficient UI worker, as it no longer needs to perform large in-memory joins during page serving.

## Fixed llm-veto-fail Errors

### Resolution
The `llm-veto-fail` errors (crashes when calling `context.llm.call`) were caused by incomplete service initialization in the background workers. While we were passing the environment to the workers, we weren't using the full engine context factory to initialize the `llm`, `vector`, and `db` services on the `PipelineContext`.

We have updated `simulation-worker.ts` to use `createEngineContext(env, "indexing")` when building the `PipelineContext`. This ensures that all simulation phases (like Timeline Fit) have access to the necessary reasoning services during background execution.

## Diagnostic Evidence
We have added explicit logging to confirm these fixes are active in the runtime environment:
1. **Service Initialization**: `simulation-worker.ts` now logs `engine.context-initialized` upon successful setup of LLM/Vector services.
2. **JSON-Blob-First**: `runArtifacts.ts` now logs `[run-artifacts] Using enriched data for X decisions (JSON-Blob-First)` when it successfully bypasses the relational DB bottleneck.

## Finalized PR and Logging
We have completed the implementation and verification of the artifact enrichment strategy and the background worker service initialization fix. Log evidence confirms the successful transition from 'llm-veto-fail' errors to active reasoning services.

### PR Summary
**Title**: Adopt Artifact Enrichment for Large Scale Simulations

**Problem**: 
Large-scale simulations were failing with 'llm-veto-fail' due to uninitialized services in workers, and 'Untitled' entries in the UI caused by SQL parameter limits during relational fetching.

**Solution**:
1. **Worker Initialization**: Updated  to use , ensuring workers have access to LLM and Vector services.
2. **Artifact Enrichment**: Updated orchestrators for Phases 7, 8, and 9 to embed titles and summaries directly into decision artifacts.
3. **UI Pivot**: Updated  to prioritize these enriched fields, bypassing the relational DB join bottleneck.

**Verification**:
Confirmed 140+  events in the logs and verified the presence of enriched metadata in processed artifacts.

## Finalized PR and Logging
We have completed the implementation and verification of the artifact enrichment strategy and the background worker service initialization fix. Log evidence confirms the successful transition from 'llm-veto-fail' errors to active reasoning services.

### PR Summary
**Title**: Adopt Artifact Enrichment for Large Scale Simulations

**Problem**: 
Large-scale simulations were failing with 'llm-veto-fail' due to uninitialized services in workers, and 'Untitled' entries in the UI caused by SQL parameter limits during relational fetching.

**Solution**:
1. **Worker Initialization**: Updated `simulation-worker.ts` to use `createEngineContext`, ensuring workers have access to LLM and Vector services.
2. **Artifact Enrichment**: Updated orchestrators for Phases 7, 8, and 9 to embed titles and summaries directly into decision artifacts.
3. **UI Pivot**: Updated `runArtifacts.ts` to prioritize these enriched fields, bypassing the relational DB join bottleneck.

**Verification**:
Confirmed 140+ `engine.context-initialized` events in the logs and verified the presence of enriched metadata in processed artifacts.
