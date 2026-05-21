---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Avoid reusing runner numbers while stable log directories still exist, and clear stale per-run timeline/log artifacts when a runner name is reused, so old `timeline.json` records cannot be merged into a fresh run and reported as a false failure.

Closes #341.
