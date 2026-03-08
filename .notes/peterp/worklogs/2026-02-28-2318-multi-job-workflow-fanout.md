---
title: Multi-job workflow fan-out & stuck "Waiting for logs..."
date: 2026-02-28 23:18
author: peterp
---

# Multi-job workflow fan-out & stuck "Waiting for logs..."

## Summary

Runner 23 was stuck on "Waiting for logs..." in the UI. Root cause: `code-quality.yml` in the `redwoodjs/sdk` repo has two jobs (`check-sdk`, `check-community`). The CLI exited with an error written to **stderr**, leaving `process-stdout.log` empty. Fixed by (1) surfacing stderr in the UI when stdout is empty, and (2) properly fanning out multi-job workflows into one runner per job.

---

## The Problem

- Clicked **Run** on `code-quality.yml` → `machinen-runner-23` spawned, UI showed "Waiting for logs..." indefinitely.
- `process-stdout.log` was **0 bytes**. `process-stderr.log` contained:
  ```
  [Machinen] Multiple tasks found in workflow. Please specify one with --task:
    - check-sdk
    - check-community
  ```
- The CLI (`cli.ts`) exited early without running anything, because no `--task` was passed and no obvious entry-point name matched.

---

## Investigation & Timeline

- **Initial state:** `runWorkflow` in `orchestrator.ts` spawned a single CLI process without `--task`. The CLI errored to stderr and exited. `getRunLogs` only read `process-stdout.log` → returned empty → UI showed "Waiting for logs...".
- **Checked `_/logs/machinen-runner-23/`** — confirmed 0-byte stdout, 105-byte stderr.
- **Checked `cli.ts`** — confirmed the "Multiple tasks found" path calls `console.error` (stderr) and `process.exit(1)`.
- **Fix 1:** `getRunLogs` now falls back to `process-stderr.log` when stdout is empty, so error messages surface in the UI.
- **Fix 2:** `runWorkflow` now calls `getWorkflowTemplate` (the existing `@actions/workflow-parser`-backed parser) to enumerate jobs, then spawns one CLI process per job with `--task <jobId>`. The common-entry-point heuristic (`test`, `ci`, `run`, `build`) still short-circuits to a single runner when applicable.

---

## Discovery & Key Findings

- **stderr swallowed silently** — the orchestrator piped stderr to a file but `getRunLogs` never read it.
- **`getWorkflowTemplate` already available** — `workflow-parser.ts` exports the full parsed template with `template.jobs`; no need for a custom YAML regex.
- **Naming scheme** — user wanted multi-job runners grouped like GitHub's "jobs" sidebar. Settled on `machinen-runner-N-001`, `machinen-runner-N-002` (all jobs share the same base number `N`), with `workflowRunId: "machinen-runner-N"` and `jobName` stored in metadata.

---

## Resolution

### `orchestrator.ts`

- `getRunLogs`: tries `process-stdout.log` → `output.log` → `process-stderr.log`, returning first non-empty.
- `runWorkflow`: refactored into `spawnRunner` helper + main function that fans out to N runners for N jobs. Runner naming:
  - Single job → `machinen-runner-N`
  - Multi job → `machinen-runner-N-001`, `machinen-runner-N-002`, …
- Metadata now includes `workflowName` (bare), `jobName` (job id or null), `workflowRunId` (base runner name).
- `getRunsForCommit`: returns `jobName` and `workflowRunId` fields.

### `ui/src/mainview/commits.ts`

- `loadRuns` groups results by `workflowRunId`.
- Single-job runs render as before.
- Multi-job runs: non-clickable header (workflow name + aggregate status) with indented clickable job rows (`└ check-sdk`, `└ check-community`).

### `server/server.test.ts`

- Added `describe("Multi-job workflow fan-out")` with two tests:
  - Multi-job YAML → 2 runners with `-001`/`-002` suffix, shared `workflowRunId`, correct `jobName`.
  - Single-job YAML → 1 plain runner, `jobName: null`, `workflowRunId` self-referential.

---

## Next Steps

- [ ] Restart supervisor dev server to pick up orchestrator changes
- [ ] Verify `code-quality.yml` now spawns two runners (`machinen-runner-N-001`, `machinen-runner-N-002`) and both appear in the UI grouped correctly
- [ ] Consider running jobs in parallel rather than sequentially (currently each `spawnRunner` fires independently — check if DTU handles concurrent runners)
