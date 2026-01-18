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
- [x] Increase log verbosity to surface item-level progress in the UI.
- [x] Force the LLM path across all simulation phases and live linking.
- [x] Verify build and ensure errors are surfaced in the UI.

## Improved host runner logging and error capture

I refactored `advanceSimulationRunPhaseNoop` in [runner.ts](file:///Users/justin/rw/worktrees/machinen_faster-better-backfill/src/app/engine/runners/simulation/runner.ts) to log a `host.phase.dispatch` event immediately before calling a registry runner. I also updated the `try/catch` block to capture stack traces and log them as `phase.error` events.

## Resolved concurrency race conditions

I implemented a locking mechanism in [runner.ts](file:///Users/justin/rw/worktrees/machinen_faster-better-backfill/src/app/engine/runners/simulation/runner.ts) using a new `busy_running` status. This prevents overlapping executions on the same run, resolving a race condition where multiple `ingest_diff` calls were resetting "changed" flags.

## Implemented granular logging and log persistence

I updated the simulation logging system to provide more visibility into "the stuff in between" phase start and end:
- Enforced `info` level log persistence by default in [logger.ts](file:///Users/justin/rw/worktrees/machinen_faster-better-backfill/src/app/engine/simulation/logger.ts).
- Added `item.success` events to `ingest_diff`, `micro_batches`, `macro_synthesis`, and `materialize_moments`.
- Added `batch.success` events to `micro_batches` for tracking individual micro-batch completion.
- Updated adapter types to support the enhanced logging interface.

## Enforced LLM path across all phases

Removed all environment-based toggles that allowed "fallback" (non-LLM) logic in simulations:
- Removed `SIMULATION_MICRO_BATCH_USE_LLM` check in `micro_batches`.
- Removed `SIMULATION_TIMELINE_FIT_USE_LLM` check in `timeline_fit`.
- Removed `MOMENT_LINKING_TIMELINE_FIT_USE_LLM` check in live linking (`rootMacroMomentLinking.ts`).
- Forced `useLlm = true` in all relevant adapters and runners.
- Updated database status reporting to always show `computed_llm` when not cached.

## Implemented automatic balanced sampling with guaranteed diversity

The listing logic now explicitly targets multiple R2 pools separately. The sampling logic guarantees a diversity round (one of each type) before filling the remaining sample size.

## Enhanced UI with default auto-run and repo controls

Updated [simulation-run-controls.tsx](file:///Users/justin/rw/worktrees/machinen_faster-better-backfill/src/app/pages/audit/subpages/simulation-run-controls.tsx) with a new GitHub Repo Filter input and an "Auto-run" toggle. The `RunControls` component now more reliably triggers the auto-run loop.

## Verified changes with successful build

I ran `pnpm build` and confirmed that all changes are type-safe and that the production bundle builds successfully. The simulation system is now protected against concurrency bugs, provides detailed feedback, and strictly follows the LLM-driven path.
