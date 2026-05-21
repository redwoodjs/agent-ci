---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Fix remote actions referenced through deep sub-paths (for example `owner/repo/.github/actions/name@ref`) by passing the parent repository and action path separately to the runner.

Closes #362.
