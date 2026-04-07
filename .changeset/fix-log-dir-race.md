---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Fix race condition in concurrent log directory allocation by using atomic mkdirSync.
