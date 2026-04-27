---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Add support for expansion of variables in the `env` context in expressions.

`env` context variables deriving from the merged step environment (workflow-level + job-level + step-level `env:`) are now expanded in expressions, matching GitHub Actions behavior. Previously these references resolved to empty strings.
