## Problem
We saw a Cursor conversation that the scope router classified as `redwood:machinen`, but later vector writes for the same document were recorded under `redwood:rwsdk`.

This indicates that the namespace used for persistence can diverge from the namespace computed during indexing.

## Context
- `src/app/engine/engine.ts` uses `env` imported from `cloudflare:workers` as a mutable store for `MOMENT_GRAPH_NAMESPACE`.
- `src/worker.tsx` queue handling mutates `env` and `workerEnv` for `MOMENT_GRAPH_NAMESPACE`, `MOMENT_GRAPH_NAMESPACE_EXPLICIT`, and `MOMENT_GRAPH_NAMESPACE_PREFIX`, then restores them.
- Multiple indexing jobs (and admin endpoints) can run in the same worker isolate.

## Evidence
For `cursor/conversations/e9bab764-5466-4085-8a3b-b32540c3ee83/latest.json` in `out.log`:
- `[scope-router] indexing` logged `namespace: redwood:machinen`.
- `[moment-linker] vector upsert` later logged `momentGraphNamespace: ...:redwood:rwsdk`.

## Hypothesis
Namespace selection is stored in mutable, process-wide `env` state.

If two indexing operations overlap, one operation can change `MOMENT_GRAPH_NAMESPACE` while another is mid-index. This can cause later stages (moment db writes, vector writes) to use a namespace different from the one that was computed for that document.

## Plan
- Stop using mutable global `env` as the transport for the current namespace.
- Thread an explicit namespace context through indexing and query operations.
- Keep admin endpoints and queue jobs able to override namespace/prefix, but apply overrides only to that operation.

## Progress
- Added `momentGraphNamespace` to the engine hook contexts so plugins can read the effective namespace without relying on global environment mutation.
- Added a helper to apply a namespace prefix from an explicit value (not by reading from env), as a building block for per-operation namespace resolution.

## Implementation notes
- I removed `MOMENT_GRAPH_NAMESPACE(_EXPLICIT/_PREFIX)` mutation from:
  - the engine (index and query code paths)
  - the engine admin routes
  - the worker queue handler for indexing jobs
- The engine now computes a per-operation effective namespace once (base namespace from scoping plugins, plus prefix) and threads it through:
  - indexing state reads/writes
  - moment db reads/writes
  - moment/subject vector upserts
- Namespace override semantics:
  - When a caller provides `momentGraphNamespacePrefix`, it is applied to the computed base namespace (or to the provided base namespace override).
  - When a caller provides `momentGraphNamespace` without a prefix, the engine treats it as already-qualified and does not apply an environment prefix.

## Validation
- I restarted the local dev server and ran `/admin/resync` for `cursor/conversations/e9bab764-5466-4085-8a3b-b32540c3ee83/latest.json` with `mode=inline` and a prefix override.
- The logs show:
  - `[scope-router] indexing` selected `namespace: redwood:machinen`.
  - `[moment-linker] vector upsert` used `momentGraphNamespace: demo-2025-12-18-namespace-context:redwood:machinen`.
  - No log lines for this document referenced `redwood:rwsdk`.
