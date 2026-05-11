---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

chore: relax published `engines.node` back to `>=22`

#351 bumped the published packages' `engines.node` to `>=24` along
with the development-side switch to Node's native TypeScript support.
End users never run our source files, only the compiled
`dist/cli.js`. That compiled output targets ES2020 and only uses APIs
available on Node 22 (the long-term support release), so the
published requirement was stricter than it needed to be.

This change:

- Sets `engines.node` to `>=22` in `@redwoodjs/agent-ci` and
  `dtu-github-actions`. End users on Node 22 stop seeing the
  "unsupported engine" warning.
- Adds `engines.node: ">=24"` to the repo-root `package.json` so
  contributors keep getting an explicit signal that the development
  scripts (which run `.ts` files directly through Node's native
  type-stripping) need Node 24.

No code change.
