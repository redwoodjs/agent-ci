# Fix GitHub Repo Filter 2026-02-05

## Initialized worklog and started investigation
We are investigating a bug where the GitHub repository filter in the simulation UI is not correctly filtering documents. We have identified several candidate files in the UI and engine/runners. We are starting by searching for the filter implementation in the UI code.
## Decided on fix strategy
We have identified that the `githubRepo` filter is not applied during the key filtering logic. We plan to:
1. Update `simulation-actions.ts` to include `githubRepo` in the run configuration and apply it during sample run filtering.
2. Update `runner.ts` to use `githubRepo` during the async listing phase.
3. Add a check to `isGithubIssue` and `isGithubPr` to ensure they match the repo if a filter is specified.
## Applied fixes
We have updated `simulation-actions.ts` and `runner.ts` to correctly apply the `githubRepo` filter. Specifically:
- `runAllSimulationRunAction` now includes `githubRepo` in the `r2List` config.
- `runSampleSimulationRunAction` and `runner.ts`'s `tickR2Listing` now use `githubRepo` to post-filter listed keys.
- This ensures that even with broad prefixes, only documents from the selected repository are included in the simulation.
## Finalized fix
We have verified that the `githubRepo` filter is now correctly applied across both synchronous and asynchronous simulation run initializations. The task is complete.
