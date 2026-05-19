---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

chore: keep TypeScript source execution compatible with Node 22

Development scripts run `.ts` entrypoints through `tsx` instead of requiring
Node 24's native TypeScript stripping. Source files still use real `.ts`
relative imports, and `tsgo` rewrites those paths to `.js` in built `dist/`
output, so consumers continue to run compiled JavaScript.
