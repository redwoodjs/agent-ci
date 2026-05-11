---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

refactor(local-job): extract three helpers out of `executeLocalJob`

`executeLocalJob` had grown to ~860 lines and scored 73 on the
cognitive-complexity metric — the highest in the `cli` package after
the previous round of refactors. Three self-contained blocks of code
inside it have been moved into module-scope helpers:

- `pullContainerImageWithProgress(docker, image, store, containerName)`
  — the ~100-line Docker pull with per-layer download / extract
  progress reporting (direct-container mode).
- `seedRunnerBinaryToHost(docker, hostRunnerSeedDir)` — the one-time
  extraction of the actions-runner binary from the seed image
  (direct-container mode).
- `waitForContainerExit(container, waitPromise, timeoutMs)` — the
  promise-race that force-stops the container if the runner does not
  exit within the timeout.

`executeLocalJob` is now ~715 lines, cognitive 56. No behaviour
change; the full local smoke suite passes.
