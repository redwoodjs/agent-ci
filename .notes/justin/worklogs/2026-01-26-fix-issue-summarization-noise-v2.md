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
The system is ready for manual verification via simulation run.