# 2026-01-26: Fix Issue Summarization Noise and Audit Log Bug

time: 2026-01-26

## Initializing Task: Fix Summarization Noise (Protocol Corrected)

### Context
We are treating "LLM Sway" (Issue 432 linked to 375 via comment noise). The correct approach is to modify the **Core** logic to handle this globally.

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
- [ ] Revert `adapter.ts` changes
- [ ] Revert `runner.ts` changes (refactor to use Core shape)
- [ ] Modify `GitHubPlugin` (`index.ts`) to improve prompt context
- [ ] Modify `deterministicLinkingOrchestrator.ts` to standardize audit return
