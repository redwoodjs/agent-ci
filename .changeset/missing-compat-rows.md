---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Flesh out `compatibility.json` with 15 rows that were absent before — features real GitHub Actions documents but our table said nothing about. Status is chosen per code inspection, so each row reflects current behaviour rather than aspirational coverage:

- **Workflow triggers**: sub-event filters `branches`/`branches-ignore` (supported), `paths`/`paths-ignore` (supported), `tags`/`tags-ignore` (unsupported), `types` (ignored), `workflow_dispatch.inputs` (ignored — dispatch itself isn't simulated), `workflow_call.inputs.*` (supported), `workflow_call.outputs.*.value` (supported).
- **Job-level**: `jobs.<id>.permissions` (ignored), `jobs.<id>.container.credentials` (unsupported), `jobs.<id>.services.*.credentials` (unsupported).
- **Step-level**: `steps[*].uses: docker://…` (unsupported — Docker-image action refs are not resolved).
- **Expressions**: `vars.*` (supported), `inputs.*` (supported), `steps.*.conclusion` / `steps.*.outcome` (unsupported), `job.*` runtime context (unsupported), `*` object-filter operator (unsupported).

No behaviour changes — just honest documentation. Closes the "missing rows" bucket on #296.
