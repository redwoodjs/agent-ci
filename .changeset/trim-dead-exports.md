---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

chore: unexport helpers that were never imported externally

`log-prune.ts` and `generators.ts` had six identifiers marked `export`
that no other file actually imported:

- `DEFAULT_RETAIN_DAYS`, `DEFAULT_RETAIN_RUNS`, `DEFAULT_THROTTLE_MS`
  (used only inside `log-prune.ts`)
- `toContextData`, `toTemplateTokenMapping`
  (used only inside `generators.ts`)
- `toContainerTemplateToken`
  (not used anywhere — wholly dead, removed)

Tightens the public surface so callers can't accidentally rely on
internal helpers, and gets a step closer to a clean dead-code report.
No runtime behaviour change.
