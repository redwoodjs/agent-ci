---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Let `hashFiles()` descend into dotted directories. The recursive walker was skipping any directory whose name starts with `.`, which meant patterns like `hashFiles('.github/workflows/*.yml')` never matched a file and returned the zero-placeholder (`"000…"`, 40 chars). Now only `node_modules` is skipped; dotted directories are walked when a pattern asks for them. The resulting digest is real SHA-256 (64 chars), matching GitHub Actions.

Closes #294.
