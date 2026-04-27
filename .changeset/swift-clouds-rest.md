---
"@redwoodjs/agent-ci": minor
"dtu-github-actions": minor
---

Stop `--pause-on-failure` from blocking forever when stdout is piped or
redirected. When the CLI detects a non-TTY invocation with `--pause-on-failure`
(and we're not under an LLM harness with `-q`), it now spawns the actual run
as a detached worker and exits with code 77 the moment the worker emits a
`run.paused` NDJSON event on stdout. The worker keeps running with the
container + DTU + signals dir alive, so a sibling `agent-ci retry --name X`
resumes it as before.

`agent-ci retry` reuses the same tail mechanism: after writing the retry
signal it tails the worker's log starting at the current end-of-file, so a
re-failure surfaces as another exit-77 in the retrying shell, a successful
completion exits 0, and a failed completion exits 1 — driven by a final
`run.completed` event the worker emits at the end of the run.

Event format: NDJSON. Each event is one JSON object per line with an `event`
discriminator (`{"event":"run.paused", ...}`, `{"event":"run.completed",
"status":"passed|failed"}`). Non-JSON log lines pass through unchanged.

TTY behavior is unchanged. Closes #315.
