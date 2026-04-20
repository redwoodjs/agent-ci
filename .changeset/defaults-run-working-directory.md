---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Propagate `defaults.run.working-directory` to steps. Workflow-level and job-level `defaults.run.working-directory` were parsed but never applied — every step ran at the workspace root regardless of the declared default. Now merged with standard GitHub Actions precedence: step override beats job default beats workflow default.

Closes #290.
