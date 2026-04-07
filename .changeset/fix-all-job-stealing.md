---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Fix --all hanging on single-job workflows due to cross-workflow job stealing.

Pin `job.runnerName = containerName` before the DTU seed call so every job goes to the runner-specific pool. Move container and ephemeral DTU cleanup into a `finally` block to ensure cleanup even on mid-run errors. Set `process.setMaxListeners(0)` to suppress EventEmitter warnings when running many parallel jobs.
