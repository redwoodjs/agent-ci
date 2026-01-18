# 2026-01-18-simulation-sampling-and-error-surfacing

## Defined the objective and initial plan

The goal is to enhance the simulation sampled runner to pick various item types (beyond just Cursor conversations), investigate "silent stalls" after the `ingest_diff` phase, and ensure errors are properly caught and surfaced in the UI.

- [x] Refactor simulation runner logic for better host-level logging (`host.phase.dispatch`) and error capture.
- [x] Implement balanced round-robin sampling across available categories (Issues, PRs, Discord, Cursor).
- [x] Guarantee at least one of each type is picked in sampled runs.
- [x] Fix alphabetical listing bias by explicitly targetting multiple R2 prefixes.
- [x] Restrict GitHub items to `latest.json` only (exclude historical snapshots).
- [x] Add GitHub repository filtering for both "Run All" and "Run Sample".
- [x] Simplify `SimulationRunControls` UI and add granular repo filtering.
- [x] Verify build and ensure errors are surfaced in the UI.

## Improved host runner logging and error capture

I refactored `advanceSimulationRunPhaseNoop` in [runner.ts](file:///Users/justin/rw/worktrees/machinen_faster-better-backfill/src/app/engine/runners/simulation/runner.ts) to log a `host.phase.dispatch` event immediately before calling a registry runner. I also updated the `try/catch` block to capture stack traces and log them as `phase.error` events, and purged the dead transition code to ensure the host logic is streamlined.

## Implemented automatic balanced sampling with guaranteed diversity

I refactored the listing logic in [simulation-actions.ts](file:///Users/justin/rw/worktrees/machinen_faster-better-backfill/src/app/pages/audit/subpages/simulation-actions.ts) to use a shared `listR2KeysHelper`. This helper explicitly lists from `github/`, `discord/`, and `cursor/conversations/` separately, mitigating alphabetical bias and enabling GitHub repository filtering.

The sampling logic now follows a two-priority approach:
1. **Guaranteed Diversity**: It first attempts to pick at least one item from each non-empty category pool (Issues, PRs, Discord, Cursor).
2. **Balanced Remainder**: It then fills the remaining sample count using a round-robin strategy across the pools.

I also updated the GitHub category filters to strictly include only `latest.json` files, ensuring that historical snapshots (e.g., those under `history/`) are filtered out of the simulation set.

## Enhanced UI with robust auto-run and repo controls

I updated [simulation-run-controls.tsx](file:///Users/justin/rw/worktrees/machinen_faster-better-backfill/src/app/pages/audit/subpages/simulation-run-controls.tsx) with a new GitHub Repo Filter input, simplified bulk configuration, and a more resilient `runAuto` loop with error surfacing.

## Verified changes with successful build

I ran `pnpm build` and confirmed that all changes are type-safe and that the production bundle builds successfully. The simulation system is now much more flexible and robust, guaranteeing current and diverse data sources for every run.
