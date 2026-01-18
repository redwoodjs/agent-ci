# 2026-01-18-simulation-sampling-and-error-surfacing

## Defined the objective and initial plan

The goal is to enhance the simulation sampled runner to pick various item types (beyond just Cursor conversations), investigate "silent stalls" after the `ingest_diff` phase, and ensure errors are properly caught and surfaced in the UI.

- [x] Refactor simulation runner logic for better host-level logging (`host.phase.dispatch`) and error capture.
- [x] Implement balanced round-robin sampling across available categories (Issues, PRs, Discord, Cursor).
- [x] Guarantee at least one of each type is picked in sampled runs.
- [x] Fix alphabetical listing bias by explicitly targetting multiple R2 prefixes.
- [x] Restrict GitHub items to `latest.json` only (exclude historical snapshots).
- [x] Add GitHub repository filtering for both "Run All" and "Run Sample".
- [x] Make auto-advancing the default behavior for all simulation starts.
- [x] Implement concurrency locking (`busy_running` status) to prevent race conditions.
- [x] Verify build and ensure errors are surfaced in the UI.

## Improved host runner logging and error capture

I refactored `advanceSimulationRunPhaseNoop` in [runner.ts](file:///Users/justin/rw/worktrees/machinen_faster-better-backfill/src/app/engine/runners/simulation/runner.ts) to log a `host.phase.dispatch` event immediately before calling a registry runner. I also updated the `try/catch` block to capture stack traces and log them as `phase.error` events, and purged the dead transition code to ensure the host logic is streamlined.

## Resolved concurrency race conditions

I diagnosed an issue where "nothing got generated" due to multiple concurrent `ingest_diff` calls for the same `runId`. These calls were racing to update the same rows in `simulation_run_documents`, causing later calls to perceive the content as "unchanged" (relative to what the first call just stored) and resetting the `changed` flag.

I implemented a locking mechanism in [runner.ts](file:///Users/justin/rw/worktrees/machinen_faster-better-backfill/src/app/engine/runners/simulation/runner.ts) using a new `busy_running` status. The host runner now performs an atomic TSL (test-and-set-lock) on the simulation status, ensuring only one phase can be processed at a time for any given run.

## Implemented automatic balanced sampling with guaranteed diversity

I refactored the listing logic in [simulation-actions.ts](file:///Users/justin/rw/worktrees/machinen_faster-better-backfill/src/app/pages/audit/subpages/simulation-actions.ts) to use a shared `listR2KeysHelper`. This helper explicitly lists from multiple R2 pools separately. The sampling logic now guarantees a diversity round (one of each type) before filling the remaining sample size.

## Enhanced UI with default auto-run and repo controls

I updated [simulation-run-controls.tsx](file:///Users/justin/rw/worktrees/machinen_faster-better-backfill/src/app/pages/audit/subpages/simulation-run-controls.tsx) with a new GitHub Repo Filter input and an "Auto-run" toggle. The `RunControls` component now more reliably triggers the auto-run loop when landing on a `running` simulation.

## Verified changes with successful build

I ran `pnpm build` and confirmed that all changes are type-safe and that the production bundle builds successfully. The simulation system is now protected against concurrency bugs and provides a much more automated, robust experience.
