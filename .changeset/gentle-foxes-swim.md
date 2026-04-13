---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Catch any "command not found" error and suggest the missing tool in the Dockerfile hint, instead of maintaining a hardcoded list of known tools.
