---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Fix handleWorkflow catch block swallowing errors by re-throwing instead of returning empty array
