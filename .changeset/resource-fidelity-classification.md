---
"@redwoodjs/agent-ci": minor
"dtu-github-actions": patch
---

Surface degraded local runs when the host machine is smaller than the runner spec declared by `runs-on:` (e.g. `ubuntu-latest-8-cores`). The job is tagged `degraded`, a warning is printed before execution, and `[degraded]` appears in CLI output. Execution is never blocked — slow runs and OOMs now have a visible cause instead of being a mystery.

Closes #229.
