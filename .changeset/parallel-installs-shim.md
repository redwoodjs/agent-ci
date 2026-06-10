---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Closes #370. Add runner package-manager install shims that serialize shared warm `node_modules` writes during parallel local Agent CI jobs and, for non-workspace projects, reuse a lockfile-keyed ready marker for duplicate project installs.
