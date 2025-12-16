# Routing Cleanup & Production Readiness (No-Break)

## Context
Preparing the system for production use by cleaning up legacy routing (`/rag` prefix) and enabling admin tools in production, while preserving existing query capabilities.

## Changes

### 1. Routing Cleanup (Removing `/rag`)
- Removed the `/rag` route prefix from `src/worker.tsx`.
- Engine routes are now mounted directly at the root:
  - `/query` (was `/rag/query`)
  - `/admin/index` (was `/rag/admin/index`)
  - `/admin/resync` (was `/rag/admin/resync`)
  - `/admin/backfill` (was `/rag/admin/backfill`)
  - `/debug/query-subject-index` (was `/rag/debug/query-subject-index`)
  - `/timeline`

### 2. Production Resync
- Removed the hardcoded host block (`machinen.redwoodjs.workers.dev`) from `resyncHandler` in `src/app/engine/routes.ts`.
- Reindexing on production is now fully enabled and gated solely by `API_KEY`.

### 3. Doc & Script Updates
- Updated `scripts/query.sh`, `manual-index.mjs`, `query-subject-index.mjs`, and READMEs to use the new root-level paths.
- Preserved `responseMode` support in `scripts/query.sh` and the engine to ensure backward compatibility for agentic tools.

---

## PR Description

### Routing Cleanup & Production Admin Enablement

**Routing**
- **Dropped `/rag` prefix:** All engine routes now live at the root (e.g., `/admin/resync`, `/query`). This simplifies the API surface area.

**Admin**
- **Enabled Prod Resync:** Removed the safety guard that blocked `/admin/resync` on the main production hostname. Admin actions are now consistently gated by `API_KEY` across all environments.

**Docs & Scripts**
- Updated all CLI scripts and documentation to reflect the new route structure.
- Verified that query `responseMode` (answer/brief/prompt) remains fully functional.

---

## Production curl commands

### Resync (enqueue mode)

```bash
curl -sS -X POST "https://machinen.redwoodjs.workers.dev/admin/resync" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "enqueue",
    "r2Keys": [
      "github/redwoodjs/sdk/issues/552/latest.json",
      "github/redwoodjs/sdk/pull-requests/933/latest.json",
      "discord/679514959968993311/1435702216315899948/threads/1373759907605516408/latest.json",
      "cursor/conversations/736f23a1-e794-4207-8bd0-5f5799e1abf4/latest.json"
    ]
  }' | jq .
```

### Single doc enqueue

```bash
curl -sS -X POST "https://machinen.redwoodjs.workers.dev/admin/index" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"r2Key":"github/redwoodjs/sdk/issues/552/latest.json"}' | jq .
```
