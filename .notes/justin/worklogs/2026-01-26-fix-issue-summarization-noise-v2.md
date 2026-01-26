# 2026-01-26: Fix Issue Summarization Noise and Audit Log Bug

time: 2026-01-26

## Initializing Task: Fix Summarization Noise (Protocol Corrected)

### Context
We investigated a data quality issue where the Knowledge Graph incorrectly linked two unrelated GitHub Issues (Issue 432 "Vite Config" linked to Parent Issue 375 "Auth Demos").

The root cause was "LLM Sway": The summarization pipeline (Macro Synthesis) was treating the Issue Body and all Comments as a single flat context. A comment on Issue 432 mentioned "Issue 375". The LLM included this reference in the summary of Issue 432, causing the Deterministic Linker to create a strong causal link between them.

We need to enforce **Identity Purity**: The identity/summary of a Moment must be derived *strictly* from the Issue Description (the author's intent), while comments should be treated as secondary context that cannot define the moment's identity.

### Plan (Work Task Blueprint / Implementation Plan)

#### 1. Directory & File Structure
```text
src/app/engine/indexing/plugins/github/
└── [MODIFY] index.ts  (Update prompt context to strictly demarcate Body vs Comments)

src/app/engine/core/linking/
└── [MODIFY] deterministicLinkingOrchestrator.ts (Ensure audit log is returned in result)

src/app/pipelines/deterministic_linking/engine/simulation/
└── [MODIFY] runner.ts (Revert hacky fix, use standard result shape)

src/app/pipelines/macro_synthesis/engine/simulation/
└── [MODIFY] adapter.ts (Revert prompt injection hack)
```

#### 2. Types & Data Structures
```typescript
export type LinkingProposal = {
  proposedParentId: string | null;
  audit: { ruleId: string; evidence: any }; // Standardized
};
```

#### 3. Invariants & Constraints
*   **Logic in Core**: Runners/Adapters are dumb pipes.
*   **Identity Purity**: A moment's identity must be derived from its primary content (Body).

#### 4. System Flow
*   **Prompting**: `GitHubPlugin` provides "schema-aware" prompt context.
*   **Auditing**: `deterministicLinkingOrchestrator` outputs the audit log; Runner saves it.

#### 5. Natural Language Context
We are fixing the "telephone game" by moving domain knowledge (what is a GitHub Issue?) to the Plugin.

#### 6. Suggested Verification (Manual)
*   **Trigger Simulation**: Run `curl -X POST ... /audit/simulation/run-sample` (or via UI).
*   **Inspect Linkage**: Use `/audit/debug-moment.json?id=32bb3390...` to check if Issue 432 is cleaner.
*   **Check Audit**: Verify `linkAuditLog` exists in the debug response.

### Tasks
- [x] Revert `adapter.ts` changes
- [x] Revert `runner.ts` changes (refactor to use Core shape)
- [x] Modify `GitHubPlugin` (`index.ts`) to improve prompt context
- [x] Modify `deterministicLinkingOrchestrator.ts` to standardize audit return

## Implementation Execution

### 1. Cleaned Up ("The Revert")
Reverted the previous "hacky" attempts in `adapter.ts` and `runner.ts` to clear the path for the architectural fix.

### 2. Applied Architectural Fixes
*   **Prompt Engineering (Plugin)**: Modified `src/app/engine/plugins/github.ts` to inject strict identity rules.
*   **Audit Integration (Runner)**: Updated `runner.ts` to correctly map the Orchestrator's `audit` payload to the storage layer, ensuring auditability.

### 3. Documentation Updates
*   **Blueprints**: Updated `knowledge-synthesis.md` (Identity Purity) and `linking-and-graph.md` (Core Audit).
*   **Workflows**: Created `global_workflows/update-arch.md` to standardize future docs maintenance.

## Next Steps
## Investigation: Linkage Discrepancy & Missing Audit Logs (Revised)

### Corrections & Constraints
- **JSON Handling**: The DB layer automatically parses JSON columns. We must **NOT** use `JSON.parse()` on selected columns.
- **Evidence Requirement**: All claims regarding linkage must be backed by concrete evidence from the data.

### Next Steps: Evidence Gathering
1.  **Database Query**: Directly inspect the `moments` table for ids `26c662cf-5242-240b-cc5e-2b25edde7b31` and `917387a7-dded-09c7-9cb1-b1b698d392ff` in the `local-2026-01-26-16-12-bright-eagle` namespace.
2.  **Verify Audit Log**: Check if `link_audit_log` is actually populated and what its type is at runtime.
3.  **Identify Linkage Trigger**: Look at the `summary` and `title` of moment `917387a7` to see if it contains `#351` or other tokens that would trigger the linker.
## Found "Smoking Gun" in Timeline Fit linkage
###
We analyzed the database and the source code, finding that moment `917387a7` (#398) was linked to `26c662cf` (#351) during the `timeline_fit` phase despite having **0 shared anchor tokens**. The code in `timelineFitDeepCore.ts` uses a greedy ranker that defaults to alphabetical ID sorting as a tie-breaker when signals are equal. Since no minimum signal threshold exists, it arbitrarily selects the first candidate.

Additionally, we confirmed that the `link_audit_log` is missing from the `moments` table because the `timeline_fit` runner (`src/app/pipelines/timeline_fit/engine/simulation/runner.ts`) does not pass the linkage decision as an audit log to `addMoment`.

### Plan
## Work Task Blueprint: Fix Arbitrary Linkage & Missing Audit Logs

### Directory & File Structure
```text
src/app/
├── engine/
│   └── lib/
│       └── phaseCores/
│           └── [MODIFY] timelineFitDeepCore.ts
└── pipelines/
    └── timeline_fit/
        └── engine/
            └── simulation/
                └── [MODIFY] runner.ts
```

### Invariants & Constraints
- **Invariants**: A linkage decision in `timeline_fit` MUST have at least 1 shared anchor token to be considered valid (unless overridden).
- **Invariants**: Every linkage decision MUST be stored in the `link_audit_log` column of the `moments` table for auditability.

### System Flow (Snapshot Diff)
**Previous Flow**: 
- `timeline_fit` ranks candidates by shared tokens -> tie-break by ID -> pick first regardless of signal.
- Runner updates moment parent but ignores the audit log.

**New Flow**:
- `timeline_fit` ranks candidates -> **IF shared tokens == 0, reject** -> pick first valid candidate (if any remain)
- Runner constructs `linkAuditLog` object and passes it to `addMoment`.

### Suggested Verification (Manual)
1. Trigger a simulation run.
2. Verify in Global Knowledge Graph that #398 is NO LONGER linked to #351.
3. Select a moment that WAS linked in `timeline_fit` and verify "Linkage" audit log is visible.


## Investigated Ghost Link for b5b7a0c0
###
We confirmed via SQLite that moment `b5b7a0c0` is correctly linked to parent `36313206` in the same database shard. The "Ghost Link" issue (where the link exists in the audit log but not in the graph view) is caused by UI constraints:
1. **Search Blindness**: The main search box only filters the list of roots. Since `b5b7a0c0` has a parent, it is hidden from the list and cannot be found via normal search.
2. **Descendant-Only Rendering**: The "Tree View" only renders descendants of the selected root. If the user views the graph for `b5b7a0c0`, they see no parent because the parent is not a descendant.
3. **Subject Isolation**: Neither moment is a "Subject", so they are hidden from the default "Subjects" tab.

### Plan
## Work Task Blueprint: Make Knowledge Graph Search Global

### Directory & File Structure
```text
src/app/
└── pages/
    └── audit/
        └── subpages/
            └── [MODIFY] knowledge-graph-page.tsx
```

### System Flow (Snapshot Diff)
**Previous Flow**: 
- Search box filters the local `rootMoments` array (roots only).
- Non-root moments are effectively invisible and un-searchable.

**New Flow**:
- Update search box to trigger a server-side search if no local results are found.
- If a non-root moment is selected from search, automatically find its root ancestor and render the full tree starting from that root.

### Suggested Verification (Manual)
1. Search for `b5b7a0c0` in the Knowledge Graph search bar.
2. Verify it now appears (or its root appears).
3. Click it and verify the graph correctly shows the link from `36313206` to `b5b7a0c0`.


## Found UI State Inconsistency in Knowledge Graph
###
We discovered that selecting a moment (e.g. clicking a parent ID in the detail view) updates the detail panel but **does not update the graph visualization**. The graph only updates when `selectedRootId` changes, which only happens when clicking the main list or using the "Go to Root" button. This explains why the user saw the parent details but the graph remained "empty" or showed the previous tree.

Additionally, the "View Context Chain" (Linear) view uses `getSubjectContextChainForMoment`, which only traverses towards **Subject** moments. Since `b5b7a0c0` and `36313206` are not subjects, the chain view for the parent stops immediately and fails to show the child.

### Plan
## Work Task Blueprint: Sync Graph View with Selection & Fix Chain Traversal

### Directory & File Structure
```text
src/app/
├── engine/
│   └── databases/
│       └── momentGraph/
│           └── [MODIFY] index.ts (getSubjectContextChainForMoment)
└── pages/
    └── audit/
        └── subpages/
            └── [MODIFY] knowledge-graph-page.tsx
```

### Invariants & Constraints
- **Invariants**: Selecting any moment MUST ensure that moment is visible in the graph view.
- **Invariants**: The "Context Chain" MUST show a moment's immediate descendants even if they are not subjects, ensuring visibility of all linked nodes.

### System Flow (Snapshot Diff)
**Previous Flow**: 
- Selecting a moment updates details but leaves the graph root unchanged.
- Context chain stops at subjects.

**New Flow**:
- Update `KnowledgeGraphPage` to automatically find and set the root ancestor when a new moment is selected.
- Update `getSubjectContextChainForMoment` to include non-subject children in its "down" traversal if no subject is found.

### Suggested Verification (Manual)
1. Select child `b5b7a0c0`.
2. Click its parent ID in the detail panel.
3. **Verify**: The Graph View automatically re-renders the parent's tree and shows the child.
4. Click "View Context Chain" for the parent.
5. **Verify**: The child is now visible in the linear chain.


## Work Task Blueprint: Knowledge Graph Synchronization & Discovery Fix

### Directory & File Structure
```text
src/app/
├── engine/
│   └── databases/
│       └── momentGraph/
│           └── [MODIFY] index.ts
└── pages/
    └── audit/
        └── subpages/
            └── [MODIFY] knowledge-graph-page.tsx
```

### Invariants & Constraints
- **Invariants**: Any moment selected in the detail view MUST be part of the currently rendered graph tree, or the graph MUST automatically pivot to its root ancestor to make it visible.
- **Invariants**: The "Context Chain" traversal MUST NOT skip non-subject descendants if no subject is present, ensuring linkage visibility for all moments.

### System Flow (Snapshot Diff)
**Previous Flow**: 
- Clicking a parent ID link in the details panel sets `selectedMomentId`.
- `KnowledgeGraphPage` updates the side panel but DOES NOT update `selectedRootId`, leaving the graph static (and often "ghosting" the link).
- `getSubjectContextChainForMoment` only searches for **subjects**, returning an empty/short chain for non-subject lineages.

**New Flow**:
- `KnowledgeGraphPage` adds an effect to monitor `selectedMomentId`. If changed and the new ID is missing from `graphData`, it triggers `getRootAncestorAction` and sets `selectedRootId` to jump the graph to the correct tree.
- `getSubjectContextChainForMoment` is updated to include immediate children in the "down" path regardless of `is_subject` status if no subject is found.

### Rationale: Subjects vs Moments
The "visibility" issue is split into two distinct bugs:
1. **The Graph (Tree View)**: This view shows **everything** (not just subjects), but it only shows **descendants** of the selected root. When you click a parent link in the details panel, the graph stays stuck on the child's (empty) subtree. The parent is "above" the root, so it's invisible. 
2. **The Context Chain (Linear View)**: This view IS strictly about **Subjects** (it skips everything else). Since your moments aren't subjects, this view fails entirely.

By syncing the graph root on selection and relaxing the subject filter in the chain view, we solve both.

### Suggested Verification (Manual)
1. Search for `b5b7a0c0` or find it in a list.
2. Click on it to open the detail panel. 
3. Click on the parent ID link (`36313206`) in the "Linkage" or "Parent ID" section.
4. **Evidence**: Verify the graph view immediately renders the tree for `36313206` and shows the arrow to `b5b7a0c0`.
5. Click "View Context Chain" for `36313206`. 
6. **Evidence**: Verify `b5b7a0c0` appears in the linear chain.


## Revised Work Task Blueprint: Knowledge Graph Synchronization & Discovery Fix

### Directory & File Structure
```text
src/app/
├── engine/
│   └── databases/
│       └── momentGraph/
│           └── [MODIFY] index.ts
└── pages/
    └── audit/
        └── subpages/
            └── [MODIFY] knowledge-graph-page.tsx
```

### Invariants & Constraints
- **Invariants**: Any selected moment must be visible in the active graph view. If a moment is selected that is not a descendant of the current root, the graph MUST pivot to that moment's absolute root ancestor.
- **Invariants**: The "Linear" (Chain) view MUST show immediate linked neighbors even if they are not marked as "Subjects".

### System Flow (Snapshot Diff)
**Previous Flow**: 
- Clicking a linkage ID in the detail view updates `selectedMomentId` but NOT `selectedRootId`.
- Graph remains stuck on the previous root, often showing an empty or irrelevant tree.
- `getSubjectContextChainForMoment` stops at non-subjects, breaking the linear view for most audit log links.

**New Flow**:
- `KnowledgeGraphPage` reactor monitors `selectedMomentId`. If changed, it checks if the ID exists in the current `graphData`. 
- If missing, it triggers `getRootAncestorAction` and updates `selectedRootId` to "jump" the graph view.
- `getSubjectContextChainForMoment` is updated to include immediate children in the "down" path if no subjects are found, ensuring the chain doesn't break prematurely.

### Rationale
The "Ghost Link" is a UI state management failure. The data is present and linked, but the visualization logic (Descendant-Only) hides parents unless they are explicitly set as roots. By syncing the root with the selection and relaxing the subject-only filter in the linear view, we ensure the graph reflects the manual navigation in the detail panel.


## Final Consensus
###
We have agreed and confirmed that:
- The data is correctly linked in the database.
- The principal issue is **Discovery**: leaf moments appear isolated because the Tree View is descendant-only.
- **Auto-Pivot** (resolving root on selection) is the fix for Tree View.
- **Relaxed Traversal** (ignoring subject filter) is the fix for Chain View.
- A new recipe has been recorded for future SQLite investigations: \`docs/dev-recipes/moment-graph-sqlite-investigation.md\`.


## Finalized Work Task Blueprint: Root-Aware Knowledge Graph Discovery

### Problem Statement
Selection from the list view (or clicking links) currently treats the selected moment as a **Root**. In a descendant-only tree view, this hides all context "above" the moment. If you select a leaf node, you see a single lonely block, even if it has a rich parentage. This is the source of the "Ghost Link" frustration.

### Directory & File Structure
```text
src/app/
├── engine/
│   └── databases/
│       └── momentGraph/
│           └── [MODIFY] index.ts
└── pages/
    └── audit/
        └── subpages/
            └── [MODIFY] knowledge-graph-page.tsx
```

### Invariants & Constraints
- **Invariants**: The Tree View MUST always show the selection in its full context (from its root ancestor down).
- **Invariants**: Selecting a moment from the sidebar MUST trigger a search for its root to ensure the link is never hidden.

### System Flow (Snapshot Diff)
**Previous Flow**: 
- Select moment `M` -> `setSelectedRootId(M)` -> Graph shows `M` and its children.
- Result: Parents and siblings are hidden.

**New Flow**:
- Select moment `M` -> Resolve `Root(M)` -> `setSelectedRootId(Root(M))` -> `setSelectedMomentId(M)`.
- Result: Graph shows the full tree where `M` lives. The link from parent to `M` is immediately visible.

### Implementation Details
1. **KnowledgeGraphPage**: Update the selection handler to automatically call `getRootAncestorAction` if the moment being selected is not already a root or part of the current graph.
2. **Backend**: Update `getSubjectContextChainForMoment` to relax the subject filter, as previously discussed, to ensure Linear view also shows non-subject links.

### Suggested Verification (Manual)
1. In the Knowledge Graph sidebar, find and click `b5b7a0c0` (the child).
2. **Verify**: The Graph View does NOT show just a single node. Instead, it shows the parent `36313206` as the root, with `b5b7a0c0` beneath it.
3. Click "View Context Chain" for `b5b7a0c0`.
4. **Verify**: The link to the parent is visible in the linear sequence.


## Case Closed: Ghost Link Misunderstanding
###
We confirmed with 100% certainty that moment `b5b7a0c0` and parent `36313206` are correctly linked in the same shard (`ac75f28a`). The "Ghost Link" was a misunderstanding of the Tree View:
1. Selecting a moment from the sidebar makes it the **Root**.
2. Tree View only shows **descendants**.
3. Therefore, selecting the child hides the parent, making the node appear isolated.

We will still proceed with the **Auto-Pivot** and **Relaxed Traversal** fixes to make the system more intuitive and prevent this confusion in the future.

### SQLite Discovery Pattern
We developed a pattern for mapping local Durable Object shards to namespaces and finding specific data across them. This has been recorded as a recipe in `docs/dev-recipes/moment-graph-sqlite-investigation.md`.

