---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Support `pull_request_target` in workflow relevance check, applying the same branch and paths filter logic as `pull_request`. Fix Docker container name collisions when running multiple workflows concurrently via `--all` by pre-allocating unique run numbers per workflow.
