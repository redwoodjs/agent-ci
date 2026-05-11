---
"@redwoodjs/agent-ci": minor
"dtu-github-actions": minor
---

chore: require Node 24 and drop `tsx`

Node 24 ships native TypeScript stripping as a stable feature, so we no
longer need the `tsx` runtime to execute `.ts` files. Every `tsx foo.ts`
invocation in package scripts becomes `node foo.ts`. `tsx` is removed
from `devDependencies` in every workspace.

To make this work with the codebase's existing import convention,
TypeScript is configured to emit `.js` paths in built output while
allowing source files to use real `.ts` extensions:

- `allowImportingTsExtensions: true`
- `rewriteRelativeImportExtensions: true`

All 72 source files have been mechanically updated: every relative
import that previously said `from "./foo.js"` now says
`from "./foo.ts"`. The compiled `dist/` output still emits the `.js`
extension, so consumers see no change.

Breaking change: the published packages now declare
`engines.node: ">=24"`. Node 22 is no longer supported.

CI: the `tests.yml` workflow bumps from Node 22 to Node 24. Smoke
workflows that set `node-version: 22` are left alone — they are
fixtures exercising specific Node versions via `actions/setup-node`,
not our project's runtime.
