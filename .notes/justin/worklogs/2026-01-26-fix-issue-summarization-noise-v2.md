# 2026-01-26: Fix Issue Summarization Noise and Audit Log Bug

time: 2026-01-26

## Initializing Task: Fix Summarization Noise

### Context
We are investigating incorrect linkage between moments (e.g., Issue 432 linked to 375). The root cause is likely "sway" in the LLM summarization where references in comments dominate the moment's identity. We also identified a bug where `linkAuditLog` was not persisted.

We have retroactively logged the "plumbing" fixes that were applied in step 198, but we now need to formalize the robust fix for the core logic.

### Plan (Work Task Blueprint)

#### 1. Directory & File Structure
```text
src/app/pipelines/macro_synthesis/engine/simulation/
└── [MODIFY] adapter.ts  (Inject instructions for GitHub Issues/PRs)

src/app/pipelines/deterministic_linking/engine/simulation/
└── [MODIFY] runner.ts   (Persist linkAuditLog - DONE in 738ddfa)

src/app/pages/audit/routes.tsx
└── [MODIFY] (Add debug endpoint - DONE in 738ddfa)
```

#### 2. System Flow (Snapshot Diff)
*   **Previous Flow**:
    *   `runMacroSynthesisAdapter` -> `getMacroSynthesisInputs` -> `prepareDocument` -> `plugins.getMacroSynthesisPromptContext`.
    *   Result: `macroPromptContext` (generic instructions or null).
    *   LLM Input: Document Body + Comments + Generic Prompt.
    *   Outcome: LLM might summarize a comment mentioning "Issue 375" as "This moment is about Issue 375".
*   **New Flow**:
    *   `runMacroSynthesisAdapter` check: Is this a GitHub Issue/PR?
    *   If YES: Prepend "Prioritize Description" instructions to `macroPromptContext`.
    *   LLM Input: Document Body + Comments + **Specific Prioritization Instruction**.
    *   Outcome: LLM ignores comment noise. "This moment is about Issue 432 (Vite Config)".

#### 3. Invariants & Constraints
*   **Invariant (Noise Filtering)**: A casual mention of an issue in a comment MUST NOT define the identity of the moment.
*   **Invariant (Auditability)**: All linkage decisions MUST be inspectable via `linkAuditLog`.
*   **Constraint**: The logic to differentiate "body" from "comments" ideally lives in the Plugin, but for this fix, we are injecting the instruction at the Adapter level where the prompt context is finalized. (User approved this approach for now, future refactor to Core/Plugin is noted).

#### 4. Natural Language Context
We are telling the LLM explicitly: "The description is the truth; comments are just chatter." This prevents the "telephone game" effect where a thread about X morphs into a moment about Y because someone mentioned Y in the comments. We also ensure that when the linker *does* find a link, we save the receipt (`linkAuditLog`) so we don't have to guess next time.

### Tasks
- [x] Fix missing `linkAuditLog` in `deterministic_linking` runner (Applied in 738ddfa)
- [x] Create debug endpoint `/audit/debug-moment.json` (Applied in 738ddfa)
- [ ] Modify `adapter.ts` to inject prioritization instructions for GitHub Issues/PRs
- [ ] Verify by running a sample simulation (User will trigger or provide token)
