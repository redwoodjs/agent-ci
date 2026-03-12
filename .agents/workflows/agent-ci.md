---
description: Run local CI to verify changes before completing work
aliases: [validate]
---

// turbo-all

1. Run agent-ci against all relevant workflows for the current branch:

```bash
pnpm agent-ci-dev run --all -q -p
```

2. Confirm all jobs passed. If any failed, fix the issue and re-run from step 1.
