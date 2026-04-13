---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Auto-pull runner image on first run with visible progress output. Previously, first-time users saw a frozen spinner or a confusing "No such image" error because the pull happened silently and failures were only debug-logged.
