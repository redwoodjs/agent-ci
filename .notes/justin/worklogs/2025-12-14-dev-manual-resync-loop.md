## Work Log: Dev Manual Resync Loop

**Date:** 2025-12-14

### Problem and scope

The feedback loop for Moment Graph / engine indexing iterations is slow:

- Changes typically need a deploy to exercise the full worker setup.
- Indexing is mostly triggered by R2 events, which then enqueue work and eventually run the engine indexing job.
- Waiting for R2 event delivery and queue processing delays testing, even when the change is in the engine logic.

This digression is about adding a developer-facing way to trigger indexing for specific R2 object keys directly, so local dev and dev deploys can run the same indexing path without relying on R2 event timing.

### Constraints

- Do not try to mimic R2 event payload shapes.
- Reuse the existing indexing job code path where possible.
- Support setting `MOMENT_GRAPH_NAMESPACE` per request so controlled A/B runs can share a namespace.
- Keep the surface gated (admin API key) and scoped to non-production.

### Plan

- Find the existing indexing trigger path (R2 updates -> queue -> `processIndexingJob`).
- Add a debug route that accepts a list of R2 keys and an optional namespace override.
- Have the route invoke indexing immediately (no queue dependency) and/or enqueue in environments where that is preferred.
- Extend the indexing job input shape to accept the manual trigger format (polymorphic inputs).
- Add a dev script variant that writes logs to a file via shell redirection.

### Notes (start)

- `momentGraphNamespace.ts` already contains a helper to read a namespace string from env and a name qualifier helper.
- `worker.tsx` currently accepts indexing queue messages in multiple shapes (`r2Key` at top-level or `body.r2Key`).

### Implementation status

Completed:

- Added a manual admin endpoint: `POST /rag/admin/resync`.
  - Requires the existing API key interruptor.
  - Returns 404 on the production host (`machinen.redwoodjs.workers.dev`).
  - Accepts either a single key or a list of keys.
  - Accepts an optional namespace override.
  - Supports two execution modes:
    - `inline`: runs indexing immediately in the request handler.
    - `enqueue`: sends messages to `ENGINE_INDEXING_QUEUE`.

- Updated engine-indexing queue handling to accept polymorphic message shapes.
  - Accepts `r2Key` or `r2Keys` (either top-level or inside `body`).
  - Accepts `momentGraphNamespace` or `namespace` (either top-level or inside `body`).
  - Applies the namespace for the duration of processing by mutating `cloudflare:workers` env and the queue handler env param, then restoring the previous values.

- Added `dev:log` script to run Vite dev with logs written to `/tmp/machinen-dev.log`.

### Manual usage

Inline indexing (fast loop, no queue wait):

```bash
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"mode":"inline","momentGraphNamespace":"test-run-6","r2Keys":["cursor/conversations/<docA>/latest.json","cursor/conversations/<docB>/latest.json"]}' \
  "http://localhost:8787/rag/admin/resync"
```

Enqueue indexing (still avoids R2 events, but uses queue consumer path):

```bash
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"mode":"enqueue","momentGraphNamespace":"test-run-6","r2Keys":["cursor/conversations/<docA>/latest.json"]}' \
  "http://localhost:8787/rag/admin/resync"
```

Dev logs to file:

```bash
npm run dev:log
# logs: /tmp/machinen-dev.log
```

### Documentation

- Updated `src/app/engine/README.md` to describe the system as Evidence Locker + Moment Graph (subject-first query path), and documented `/rag/admin/resync`.
