---
"@redwoodjs/agent-ci": minor
"dtu-github-actions": minor
---

Colocate per-run log artifacts with the checks JSON under `<stateDir>/logs/` (override via `AGENT_CI_LOG_DIR`) so log paths recorded in the run-result JSON survive OS-level pruning of `os.tmpdir()`. Add an opportunistic, throttled cleanup that runs at the start of `agent-ci run` plus an explicit `agent-ci clean` command. Knobs: `AGENT_CI_LOG_RETAIN_DAYS` (default 7), `AGENT_CI_LOG_RETAIN_RUNS` (default 20), `AGENT_CI_LOG_PRUNE=0` to disable. Closes #312.

Also fix `buildStepEnv` to thread an `envContext` through `expandExpressions`, completing the env.\* expansion fix from #320 — `${{ env.JOB_KEY }}` inside another step's `env:` value now resolves to the workflow- or job-level value instead of an empty string.
