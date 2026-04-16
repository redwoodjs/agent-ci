---
"@redwoodjs/agent-ci": minor
"dtu-github-actions": minor
---

Add support for `${{ vars.FOO }}` expressions in local workflow runs. Supply vars via `.env.agent-ci.vars` file or shell environment variables, mirroring the existing secrets layer.
