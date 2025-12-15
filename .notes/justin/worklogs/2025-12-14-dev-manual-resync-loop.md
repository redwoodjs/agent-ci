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
  -H "Content-Type: application/json" \
  --data '{"mode":"inline","momentGraphNamespace":"test-run-6","r2Keys":["cursor/conversations/<docA>/latest.json","cursor/conversations/<docB>/latest.json"]}' \
  "http://localhost:5173/rag/admin/resync"
```

Enqueue indexing (still avoids R2 events, but uses queue consumer path):

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  --data '{"mode":"enqueue","momentGraphNamespace":"test-run-6","r2Keys":["cursor/conversations/<docA>/latest.json"]}' \
  "http://localhost:5173/rag/admin/resync"
```

Concrete Doc A / Doc B keys from logs:

- Doc A: `cursor/conversations/6e15efeb-263c-4ff0-94db-17277c76f50e/latest.json`
- Doc B: `cursor/conversations/979d250a-d6ac-4567-a76d-961c1897d370/latest.json`

Run inline indexing for both in a shared namespace:

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  --data '{"mode":"inline","momentGraphNamespace":"test-run-6","r2Keys":["cursor/conversations/6e15efeb-263c-4ff0-94db-17277c76f50e/latest.json","cursor/conversations/979d250a-d6ac-4567-a76d-961c1897d370/latest.json"]}' \
  "http://localhost:5173/rag/admin/resync"
```

Or run them one at a time (inline):

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  --data '{"mode":"inline","momentGraphNamespace":"test-run-6","r2Key":"cursor/conversations/6e15efeb-263c-4ff0-94db-17277c76f50e/latest.json"}' \
  "http://localhost:5173/rag/admin/resync"
```

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  --data '{"mode":"inline","momentGraphNamespace":"test-run-6","r2Key":"cursor/conversations/979d250a-d6ac-4567-a76d-961c1897d370/latest.json"}' \
  "http://localhost:5173/rag/admin/resync"
```

Dev logs to file:

```bash
npm run dev:log
# logs: /tmp/machinen-dev.log
```

### Documentation

- Updated `src/app/engine/README.md` to describe the system as Evidence Locker + Moment Graph (subject-first query path), and documented `/rag/admin/resync`.

### Note (local dev auth)

When running under the Vite dev server, admin and query routes do not require the API key. This is gated by `import.meta.VITE_IS_DEV_SERVER` so deployed environments still require the `Authorization: Bearer $API_KEY` header.

---

## PR title

Smart Linker: cross-document attachment, namespace isolation, and local resync loop

## Smart Linker

Previously, the Moment Graph treated each document as an isolated island—a single linear timeline that became its own Subject (root moment). This was limited because real-world knowledge is scattered across many conversations, PRs, and issue threads. If I discuss "auth refactor" in a Cursor chat today, and continue it in a Discord thread tomorrow, the system should see them as one connected narrative, not two separate ones.

The challenge is that different data sources (Cursor, Discord, GitHub) and different entities (conversations, threads) need to be linked under the same subject without manual tagging. We need a way to automatically detect that a new document belongs to an existing timeline and "stitch" it in place.

The Smart Linker solves this by adding a semantic correlation step during indexing. Before creating a new Subject, it embeds the incoming document (using a concatenated view of its micro-moments) and queries the vector index for existing related moments. If a match is found above a similarity threshold, the system attaches the new document's first macro-moment as a child of the matched moment.

This approach creates a **branching Moment Graph** where a single Subject can have multiple timelines merging into it. To make this work practically, we refined several behaviors:
- **Branching:** Allowed attachment to any moment (not just roots), so a conversation can branch off from specific point in a previous timeline.
- **Query Trails:** Updated the query engine to prefer "moment trails" (ancestor chains from specific matched moments) over generic subject-first retrieval, ensuring answers reflect the specific branch where the match occurred.
- **Better Summaries:** Improved micro-moment summarization by injecting source-specific context (e.g., "this is an AI coding assistant conversation") into the LLM prompt, ensuring the semantic embeddings have concrete anchors like file paths and error messages rather than generic chatter.

## Changes to make dev more practical and fast

Validating the Smart Linker was slow and painful because it relied on the full async ingestion pipeline: deploy the worker, upload a file to R2, wait for the event notification, wait for the queue, and hope tail logs didn't get sampled. This cycle took minutes per attempt and made it hard to run controlled A/B tests (e.g., "does Doc B attach to Doc A?").

We solved this by building a **manual resync loop** and **namespace isolation**:

- **Manual Resync Endpoint:** Added `POST /rag/admin/resync` to trigger indexing for specific R2 keys immediately (`inline` mode) or via the queue (`enqueue` mode), bypassing R2 event delays.
- **Local Log Capture:** Added `npm run dev:log` to pipe local dev logs to a file, avoiding tail sampling and making it easy to grep for linker decisions.
- **Namespace Isolation:** Implemented full isolation for test runs. We now write `momentGraphNamespace` metadata to vector indexes and apply a **query-time metadata filter** when reading. This ensures that a test run for "feature-branch-x" never sees stale candidates from "default" or previous runs, preventing false negatives (where valid matches were starved out of top-k by stale data). We also documented the requirement to create Vectorize metadata indexes for this filtering to work.