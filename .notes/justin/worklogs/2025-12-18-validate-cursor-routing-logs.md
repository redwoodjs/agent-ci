## Problem
Cursor conversation documents were routing to the internal Moment Graph namespace even when the raw documents contain workspace roots that point at the SDK repo.

I want to validate that the latest resync run is now:
- extracting workspace roots from the cursor conversation JSON (including event-level roots)
- inferring the expected project from those roots
- writing moments to the expected namespace (including the configured namespace prefix)

## Context
- Resync was done via `/admin/resync` for several cursor conversation R2 keys.
- Routing for cursor documents should use workspace roots only, with this precedence:
  - if any root is not recognized as rwsdk or machinen, route to internal
  - else if any root matches machinen, route to machinen
  - else if any root matches rwsdk, route to rwsdk
  - else route to internal

## Plan
- Inspect `/tmp/out.log` around the cursor conversation resync blocks.
- Confirm each cursor document shows a non-empty workspace roots sample.
- Confirm inferred project and resulting momentGraphNamespace match the precedence rules.

## Validation (from /tmp/out.log)
- Cursor documents show non-empty `workspaceRootsSample` and a non-null project in the `[scope-router] indexing` log line.
- There are 6 cursor documents indexed in this run, and none of them show `project: null`.
- Examples:
  - `cursor/conversations/c0be8a78-20ef-41c8-861e-69538f801dc7/latest.json`
    - `[scope-router] indexing`: `project: rwsdk`, `namespace: redwood:rwsdk`, `workspaceRootsSample: ["/Users/peterp/gh/redwoodjs/sdk"]`
    - Vector writes: `momentGraphNamespace: demo-2025-12-18-attempt-3:redwood:rwsdk`
  - `cursor/conversations/00b2d1cf-151c-4681-bd9d-b778fcc2ea37/latest.json`
    - `[scope-router] indexing`: `project: rwsdk`, `namespace: redwood:rwsdk`, `workspaceRootsSample: ["/Users/peterp/gh/redwoodjs/sdk"]`
  - `cursor/conversations/736f23a1-e794-4207-8bd0-5f5799e1abf4/latest.json`
    - `[scope-router] indexing`: `project: machinen`, `namespace: redwood:machinen`, `workspaceRootsSample: ["/Users/justin/rw/worktrees/machinen_cross-data-source"]`
    - Vector writes: `momentGraphNamespace: demo-2025-12-18-attempt-3:redwood:machinen`

## Notes: where the prefix applies
- The scope router emits an unprefixed namespace in logs (for example `redwood:rwsdk`). This is the base namespace.
- The engine applies `MOMENT_GRAPH_NAMESPACE_PREFIX` to the base namespace and sets `MOMENT_GRAPH_NAMESPACE` to the prefixed value for the duration of the indexing/query call.
- Moment DB and indexing-state DB routing both derive their Durable Object instance name from `MOMENT_GRAPH_NAMESPACE`, so they use the prefixed namespace string (via `qualifyName(...)`).
- Vector writes also use `MOMENT_GRAPH_NAMESPACE` for `momentGraphNamespace` in metadata, and the logs show prefixed values like `demo-2025-12-18-attempt-3:redwood:rwsdk`.
