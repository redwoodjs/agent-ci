---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

refactor(workflow-parser): split the GitHub Actions expression evaluator

Collapses the eight-parameter context that `resolveExprAtom` /
`evaluateExprValue` were threading through every recursive call into a single
`ExprContext` object, extracts each built-in function (`hashFiles`, `fromJSON`,
`toJSON`, `format`, `contains`, `startsWith`, `endsWith`, `join`) into its own
handler, and moves context-variable lookups (`runner.*`, `github.*`, `matrix.*`,
`secrets.*`, `vars.*`, `inputs.*`, `steps.*`, `needs.*`, `env.*`) into
`resolveContextRef`. `expandExpressions`'s public positional signature is
unchanged.

No behavioral changes.
