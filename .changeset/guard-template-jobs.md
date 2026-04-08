---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Guard against undefined template.jobs from workflow parser to prevent TypeError crash.
