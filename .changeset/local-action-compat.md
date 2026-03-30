---
"@redwoodjs/agent-ci": minor
---

Add unsupported workflow features detection with helpful error messages

Detects and provides actionable guidance for:

- Local composite actions (`uses: ./path/to/action`)
- Reusable workflows (`uses: ./.github/workflows/...`)
- `workflow_call` triggers
- Various unsupported options (concurrency, timeouts, continue-on-error)

Provides clear error messages with links to GitHub issues and workarounds.
