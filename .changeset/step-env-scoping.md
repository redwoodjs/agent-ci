---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Stop step-level `env:` from leaking into sibling steps. Each step's env now attaches as its own `environment` on the mapped step rather than being merged into the job-wide `EnvironmentVariables` map, where a later step's values could override an earlier step's reads of the same key.
