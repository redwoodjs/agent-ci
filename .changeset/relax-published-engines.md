---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

chore: keep `engines.node` at `>=22`

The published packages run compiled JavaScript and do not require Node 24's
native TypeScript stripping. Keep the public package engines, private
workspace engine, and PR test workflow aligned to the Node 22 runtime we
support.
