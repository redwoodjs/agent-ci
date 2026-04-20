---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Split the remaining overloaded rows in `compatibility.json` so each documented feature has a row that reflects its real status. Pure documentation — no behaviour changes.

- **`github.*`** — split into three rows: `github.sha` (real from git), `github.repository` / `github.repository_owner` (derived from the remote), and a catch-all row documenting that everything else resolves to a static default or an empty string. The catch-all enumerates the rest of the context so a reader can tell `workflow_sha`, `triggering_actor`, etc. are not populated.
- **`runner.*`** — added a row for the unsupported siblings (`runner.name`, `runner.temp`, `runner.tool_cache`, `runner.debug`, `runner.environment`) so it's visible that only `runner.os` / `runner.arch` resolve.
- **`contains` / `startsWith` / `endsWith`** — three separate rows with per-function notes.
- **`success()` / `failure()` / `always()` / `cancelled()`** — downgraded to `partial` with a note clarifying that `cancelled()` always returns `false` locally (no cancellation signal).
- **`on` (other events)** — kept as one row but the note now enumerates the ~20 event names it covers so users can see exactly which triggers are no-ops.

Closes the "overloaded row" bucket on #296.
