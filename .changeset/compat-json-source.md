---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Make `packages/cli/compatibility.json` the single source of truth for the YAML compatibility matrix. The `compatibility.md` document and the website's compatibility table are both derived from it — run `pnpm compat:gen` after editing the JSON. `pnpm check` fails if the `.md` drifts out of sync.
