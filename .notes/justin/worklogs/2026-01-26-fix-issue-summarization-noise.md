# 2026-01-26: Fix Issue Summarization Noise and Audit Log Bug

### Context
We are investigating incorrect linkage between moments (specifically Issue 432 linking to Issue 375). The user identified that:
1.  The `linkAuditLog` was missing, making it impossible to see *why* the link happened in the UI.
2.  The linkage likely occurred because of "noise" in the content (comments) swaying the system (likely the LLM-based summarization or anchor extraction).

We need to fix the audit log persistence (done) and then modify the summarization/processing logic for GitHub Issues/PRs to prioritize the description/body over comments.

### Goal
1.  Ensure `linkAuditLog` is persisted (Fixed).
2.  Modify GitHub Issue/PR processing to focus on the description for the "gist" and avoid noise from comments.
3.  Verify by running a sample simulation.

### Work Log

#### [x] Fix missing `linkAuditLog` in `deterministic_linking` runner
*   **Discovery**: The `runner.ts` for `deterministic_linking` was calculating the proposal but not passing `proposal.audit` into the `addMoment` call's `linkAuditLog` field.
*   **Fix**: Patched `src/app/pipelines/deterministic_linking/engine/simulation/runner.ts` to include `linkAuditLog: proposal.audit`.
*   **Verification**: Created a debug endpoint (`/audit/debug-moment.json`) to verify the field is missing (and will be present in future runs).

#### [x] Investigate Linkage Logic
*   **Finding**: Confirmed Issue 375 and 432 identities. 432 linked to 375.
*   **Hypothesis**: The linkage (likely deterministic) was triggered by a reference found in the *summary* of 432, which may have included text from a comment mentioning 375.
*   **Plan**: Modify the summarization logic to be robust against comment noise.

#### [ ] Modify GitHub Issue/PR Summarization to Prioritize Description
*   **Plan**:
    1.  Locate the summarization logic (likely in `macro_synthesis`).
    2.  Update the prompts or data selection to explicitly prioritize the issue body/description.
    3.  Ensure comments are either excluded or strictly demarcated as secondary/discussion, preventing them from dominating the "identity" of the moment.

#### [ ] Run Verification Sample
*   **Plan**: Run a fresh 50-item sample simulation to verify the fix and general graph health.
