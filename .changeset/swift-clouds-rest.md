---
"@redwoodjs/agent-ci": minor
"dtu-github-actions": minor
---

Stop `--pause-on-failure` from blocking forever when stdout is piped or
redirected, and emit a structured NDJSON event stream in agent-output mode.

**Pause-on-failure unblock (#315).** When the CLI detects a non-TTY invocation
with `--pause-on-failure` (and we're not under an LLM harness with `-q`), it
now spawns the actual run as a detached worker and exits with code 77 the
moment the worker emits a `run.paused` NDJSON event on stdout. The worker
keeps running with the container + DTU + signals dir alive, so a sibling
`agent-ci retry --name X` resumes it as before.

`agent-ci retry` reuses the same tail mechanism: after writing the retry
signal it tails the worker's log starting at the current end-of-file, so a
re-failure surfaces as another exit-77 in the retrying shell, a successful
completion exits 0, and a failed completion exits 1 — driven by a final
`run.finish` event the worker emits at the end of the run.

**Structured event stream (#289).** New `--json` flag (and `AGENT_CI_JSON=1`
env var) makes the CLI emit NDJSON lifecycle events on stdout — one JSON
object per line, each with an `event` discriminator field:

- `run.start` — `{ts, schemaVersion: 1, runId}`
- `job.start` / `job.finish` — `{ts, job, runner, workflow, status?, durationMs?}`
- `step.start` / `step.finish` — `{ts, job, runner, step, index, status?, durationMs?}`
- `run.paused` — `{ts, runner, step?, attempt?, workflow?, retry_cmd}`
- `run.finish` — `{ts, status: "passed"|"failed", durationMs?}`
- `diagnostic` — `{ts, level, message}`

`--json` is decoupled from `--quiet` so existing `-q` callers keep their
silent stdout. The animated renderer is auto-suppressed under `--json` so
ANSI sequences don't collide with the JSON stream. Existing human-readable
lines on stderr are unchanged. Non-JSON log lines pass through unchanged.
Per-line `step.log` streaming is deferred to a follow-up.

TTY behavior is unchanged. Closes #315 and #289.
