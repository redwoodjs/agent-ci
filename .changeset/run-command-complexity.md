---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

refactor(cli/run): split `runCmd` and `handleWorkflow` into focused helpers

`packages/cli/src/commands/run.ts` housed two very long orchestrator
functions. Static analysis (fallow health) scored them as the two
highest-complexity functions in the cli package:

- `runCmd` — cognitive 91, ~228 lines
- `handleWorkflow` — cognitive 136, ~717 lines

They mixed argument parsing, workflow discovery, matrix expansion,
resource classification, scheduling, wave execution, and final reporting
in a single body, which made each one hard to follow and hard to change.

This change pulls clearly bounded steps out into top-level helpers
without changing any observable behaviour:

- `parseRunArgs`, `parseJobsFlag`, `parseVarFlag`, `resolveGithubTokenFlag`,
  `discoverRelevantWorkflows`, `resolveWorkflowArgPath`, `finalizeRun` —
  carved out of `runCmd`.
- `expandJobs`, `classifyJobsResources`, `runWaveJobs` — carved out of
  `handleWorkflow`. The `ExpandedJob` type is lifted to module scope so
  the new helpers can take it.

New scores (fallow health):

- `runCmd`: cognitive 9 (was 91)
- `handleWorkflow`: cognitive 61 (was 136)
- `parseRunArgs`: cognitive 26 (new, replaces the inline arg loop)

No runtime behaviour change; full smoke suite passes.
