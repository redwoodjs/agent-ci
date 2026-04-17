---
"@redwoodjs/agent-ci": minor
"dtu-github-actions": patch
---

Support `env:` at workflow and job level (not just step level).

Previously the workflow parser only read `env:` declared directly on a step. Workflow-level and job-level `env:` blocks were silently ignored, so any workflow that relied on them — including workflows that referenced `${{ vars.X }}` in a job-level env — saw empty values at runtime.

The parser now merges `env:` from all three levels per the GitHub Actions spec: workflow → job → step, step-most-specific wins. Expressions (including `${{ vars.X }}`, `${{ secrets.X }}`, etc.) are expanded per-level.

This also makes the `smoke-vars-preflight.yml` Case 3 assertion actually verify the feature it documents — previously the assertion depended on env leaking in from the outer runner process.
