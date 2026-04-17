---
"@redwoodjs/agent-ci": minor
"dtu-github-actions": minor
---

Add support for `${{ vars.FOO }}` expressions in local workflow runs. Supply vars via the `--var KEY=VALUE` CLI flag (repeat for multiple). Runs fail with a clear error listing the missing vars if any required var is not provided.
