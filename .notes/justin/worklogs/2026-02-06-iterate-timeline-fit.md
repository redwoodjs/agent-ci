# Overhaul Timeline Fit Phase (Phase 8) 2026-02-06

## Investigated Phase 8 (Timeline Fit) and Stream Continuity
We analyzed the current linking logic in Phase 8 and found it relies too heavily on semantic similarity and shared anchors, often ignoring the intrinsic continuity of the work streams generated in Phase 3. 

Since Phase 3 (Macro Synthesis) already organizes moments into coherent streams, we decided that the source of truth for continuity should be captured during **Phase 5 (Materialize Moments)**. By tracking the predecessor ID during the materialization loop, we can provide Phase 8 with a "Continuity" signal that is 100% reliable.

## Investigated Ancestry Lookup for Context
We realized that judging a moment link in isolation is fragile. To improve LLM accuracy, we must provide the "narrative history" of each candidate. By walking up the graph from a candidate moment using `findAncestors`, we can retrieve the last 5-10 moments that led to it. This provides the LLM with a clear "timeline" for each candidate, allowing it to see if the new child is a natural continuation of that specific thread.

## Revised Work Task Blueprint: Narrative-Aware Timeline Fit

### Context
We are overhauling Phase 8 to move from a vector-heavy ranking to a narrative-aware selection process. Continuity is preserved as a hard link (Priority 1), while other candidates are filtered for time-sanity and shortlisted via a blended score. For selection, an LLM reviews the Child against each candidate's **full ancestral narrative** (history) to identify the most natural continuation.

### Breakdown of Planned Changes
- **Phase 5 (Materialize Moments)**: Update logic to track the `predecessorId` within each stream and store it in `sourceMetadata.simulation.predecessorMomentId`.
- **Phase 7 (Candidate Sets)**: Ensure the predecessor moment is explicitly included and tagged with `isPredecessor: true`. Increase candidate limit to 10.
- **Phase 8 (Timeline Fit)**:
    - **Strict Chronological Pre-filtering**: Reject any candidates that are not earlier in time than the child (`time-inversion`) before anything else.
    - **Ancestry Lookup**: Fetch the last 5-10 moments in the chain for each candidate (using `findAncestors`) to provide narrative context.
    - **Blended Ranking**: Prioritize Continuity, then shortlist 10 candidates using a blended score (Semantic Similarity + Shared Anchors).
    - **LLM Selection Refactor**:
        - Move from "Veto" to "Selector" pattern.
        - **FULL PROMPT SPECIFICATION**:
        ```text
        You are the Timeline Fit Judge for "Machinen", an engine that reconstructs work history from event fragments (moments).

        ### THE JOB
        We have a "Child" moment and a list of "Candidate" parent moments. Your task is to select the ONE candidate that represents the natural continuation of the timeline of moments.

        ### WHAT IS A "NATURAL CONTINUATION"?
        A link is only valid if the Child is a natural next step or significant development of the Parent's activity.
        - LINK: A situation -> Its evolution or consequence (e.g., Company hire -> Consequent win).
        - LINK: A problem -> Its investigation or resolution.
        - LINK: An initiative -> Its next major milestone.
        - LINK: A question -> Its answer.
        - LINK: Part 1 of a narrative -> Part 2 of that same narrative.

        - NO LINK: Two unrelated events happening at the same time.
        - NO LINK: Superficial semantic overlap (e.g. both mentions the same entities or terms but in entirely different contexts).

        ### CONTEXT
        - Child Moment: {{child_text}}
        - Child Timestamp: {{child_time}}

        ### CANDIDATES
        {{#each candidates}}
        [{{index}}] ID: {{id}}
        TITLE: {{title}}
        SUMMARY: {{summary}}
        TIME: {{relative_time}} earlier

        #### ANCESTRY (HISTORY OF THIS CANDIDATE)
        {{#each ancestry}}
        - {{title}}: {{summary}}
        {{/each}}
        ---------------------------------
        {{/each}}

        ### OUTPUT
        Return JSON:
        {
          "selectedId": "...", // The ID of the best parent, or null if none fit
          "note": "..." // A brief 1-sentence explanation of why this is the natural progression.
        }
        ```
    - **Evidence Persistence**: Capture the LLM's reasoning `note` and signal details in the database Link Audit Log.

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
    ancestry?: Array<{ title: string; summary: string }>;
  };
};
```

### Invariants & Constraints
- **Invariant**: A moment cannot link to a parent that was created later in time.
- **Constraint**: Narrative continuity (ancestry context) must inform the final judgment.

### System Flow (Snapshot Diff)
**Previous Flow**: Vector/Anchor Search -> Mixed Ranking -> Terse Veto -> Selection.
**New Flow**: Predecessor + Vector/Anchor Search -> **Blended Ranking** -> **Ancestry Context Retrieval** -> **LLM Selection** (10 candidates + ancestry + narrative definitions) -> Selection w/ Evidence.

### Tasks
- [ ] Update `materialize_moments` to capture `predecessorMomentId`
- [ ] Update `candidate_sets` to inject predecessor candidate (limit 10)
- [ ] Implement Ancestry Lookup logic in Phase 8
- [ ] Refactor Phase 8 orchestrator for strict time filtering and blended ranking
- [ ] Implement full LLM selection prompt template with ancestry context
- [ ] Update artifact storage to capture reasoning and evidence labels

## Architectural Decision: The Global Decision Barrier 2026-02-06
We decided to explicitly record the rationale for our two-pass approach (Materialize all -> Link all).

### Decision
The engine must ensure all moments for a document (or set of documents) are fully materialized before any linking or timeline fit logic begins.

### Rationale
Previously, we encountered "local optimum" failures where the system would choose a poor candidate simply because it was the first one available in a streaming or poorly ordered sequence. By enforcing a **Global Decision Barrier** at Phase 5 (Materialize), we ensure that Phases 7 and 8 have access to the entire pool of potential moments. This allows for a more "Rational Reporter" style of judgment, choosing the best link from the complete set rather than the most convenient link from a partial set.

## Refined Prompt Context and Fixed Circular Ancestry 2026-02-06
We improved the quality of the Timeline Fit prompt and fixed a critical logic bug regarding ancestry.

### Prompt Refinement
- **Relative Time**: Propagated `createdAt` from Phase 7 through to Phase 8. This replaces the "unknown time earlier" placeholder with actual durations (e.g., "12 mins earlier"), giving the LLM accurate narrative tempo.
- **SourceMetadata**: Decided to skip `sourceMetadata` for now to avoid complexity, relying on `createdAt` as a sufficient proxy for chronological ordering.

### Circularity Fix
- **Ancestry Filtering**: Discovered that the Child Moment was appearing in the Ancestry of its own candidates in logs. Implemented a strict filter in `computeTimelineFitProposalDeep` to exclude the Child from any candidate's history, preventing potential infinite loops in the graph.

## Implemented Robust LLM JSON Parsing 2026-02-06
We solved the recurring `Unexpected token` errors in Phase 8 caused by the LLM wrapping its response in markdown code blocks.

### The Problem
The LLM occasionally returns responses like:
\```json
{ "selectedId": "...", "note": "..." }
\```
A standard `JSON.parse()` fails on the backticks, causing the engine to discard the LLM's decision and orphan the moment.

### The Solution
- **`parseLLMJson` Utility**: Created a resilient parser in `src/app/engine/utils/llm.ts` that uses regex to extract content from markdown code blocks and finds the outermost braces as a fallback.
- **Orchestrator Integration**: Updated `computeTimelineFitDecision` in `src/app/pipelines/timeline_fit/engine/core/orchestrator.ts` to use this utility. This ensures that valid narrative links are preserved even when the LLM adds formatting "noise."

## Implemented and Verified Robust JSON Parsing for LLM Selection
We swapped the strict `JSON.parse()` in `computeTimelineFitDecision` for a custom `parseLLMJson` helper in `src/app/engine/utils/llm.ts`. This helper resiliently extracts JSON from markdown-wrapped responses, ensuring we don't drop narrative links due to formatting noise. Verification in `/tmp/sim.log` shows `llm-selector-result` entries succeeding where they previously failed with JSON syntax errors.

## PR: Narrative-Aware Timeline Fit and Robust Link Selection

### Problem and Context
Previously, Phase 8 (Timeline Fit) was fragile. It relied on simple semantic similarity scores and generic anchor matches, which often resulted in "locally optimal" but narrative-incorrect links. Furthermore, the selection process lacked historical context, causing the LLM to make judgments in isolation. Finally, strict JSON parsing often crashed the engine when the LLM returned markdown-formatted responses (ticks), leading to orphaned moments and broken narrative chains.

### Solution
We overbalanced Phase 8 from a vector-heavy ranking to a narrative-aware selection process:

1.  **Continuity Signal (Phase 5 \u0026 7)**: We now capture the `predecessorMomentId` during materialization in Phase 5 and inject it as a P1 candidate in Phase 7.
2.  **Ancestry-Driven Context (Phase 8)**: The orchestrator now retrieves the last 5-10 historical moments (ancestry) for every candidate.
3.  **Narrative Judge (LLM Selection)**: The LLM acts as a selector, reviewing the child against the candidates and their ancestry using a specific definition of "Natural Continuation" (investigation, answer, milestone).
4.  **Robust Selection Engine**: Swapped strict `JSON.parse()` for a custom `parseLLMJson` helper in `src/app/engine/utils/llm.ts`. This ensures formatting noise (markdown ticks) doesn't drop narrative links.
5.  **Evidence-First Auditing**: The LLM's reasoning (`note`) and ancestry context are stored in the database Link Audit Log for full inspectability.

These changes ensure the Knowledge Graph reflects the actual "story" of the work rather than just a bag of similar-looking event fragments.
