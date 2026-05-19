---
"@redwoodjs/agent-ci": minor
"dtu-github-actions": minor
---

Add `agent-ci run --var-file <path|->` for loading workflow variables from JSON files or GitHub CLI `gh variable list --json name,value` output piped on stdin. Explicit `--var KEY=VALUE` flags override file-provided values.

Closes #358.
