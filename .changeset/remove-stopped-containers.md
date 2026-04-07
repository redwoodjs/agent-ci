---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Remove stopped agent-ci containers before pruning networks to prevent address pool exhaustion.
