---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

chore: remove unused runtime dependencies

Three runtime dependencies were declared in `package.json` files but
never imported by any source file in the package:

- `log-update` from `@redwoodjs/agent-ci` (the diff-renderer module
  replaced it long ago; only stale code comments remain).
- `jsonc-parser` from `dtu-github-actions`.
- `yaml` from `@redwoodjs/ts-runner` (the `cli` package still depends
  on `yaml`; this only drops the unused declaration in `ts-runner`).

Smaller `node_modules`, smaller published packages, and one fewer
thing to keep up to date when the upstream releases a new version.
No runtime behaviour change.
