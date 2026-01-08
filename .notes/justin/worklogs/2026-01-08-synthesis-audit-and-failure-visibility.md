# 2026-01-08 - Synthesis audit and failure visibility

## Problem

We want a methodical way to answer:

- Why did a document produce certain macro moments (especially noisy coordination moments)?
- Which documents failed to produce moments due to errors (chunking, micro moment computation, macro synthesis, or indexing errors)?

We already persist document-level synthesis failures (parse failure and error) to document audit logs, but we do not capture:

- The successful macro synthesis output (or a compact representation of it).
- The gating decisions (kept vs dropped, and why).
- A way to list recent documents that failed to produce moments.

## Plan

- Persist successful macro synthesis audit:
  - prompt hash and response preview
  - parsed stream/macro summaries (stream id, title, importance, indices count)
  - gating decisions (kept/dropped with reasons)
  - linking anchor selection (macro index and concatenated query preview used for the smart linker)
- Persist indexing failures to document audit logs (document id + error message + stage).
- Add endpoints:
  - fetch document audit logs for a document id
  - fetch recent documents with synthesis/indexing failures
- Add audit UI:
  - per-moment panel should show document audit logs
  - a small “recent failures” list should show which documents had failures, with a link to the ingestion file viewer
- Build-check.

## Log

- Started implementation.
- Added document audit logging for successful macro synthesis:
  - macro stream synthesis success now records prompt hash and a response preview.
  - per-stream summary is persisted (macro count and titles).
  - per-stream gating summary is persisted (input/output counts and the kept titles).
  - the selected link anchor macro (index/title/importance) is persisted along with a concatenated summary preview used for smart-linker querying.
- Added document audit logging for failures:
  - micro moment batch computation errors and embedding errors are written with batch metadata.
  - a stage-tagged indexing error record is written when indexing throws.
  - a record is written when no macro streams are produced.
- Added listing/query support:
  - moment DB helper to list recent documents with audit events (dedup by document id).
  - worker admin endpoints to fetch audit logs for a document and fetch recent audit documents.
  - audit UI now shows a “Recent failures” card.
- Ran `npm run build`.
- Added deterministic Discord macro noise filtering in the per-stream gate:
  - drops coordination/status moments (afk, apology, sync, meeting/call, scheduling) unless there are technical anchors
  - allows tuning via `MACRO_MOMENT_DISCORD_NOISE_PATTERNS`
  - writes `noiseDroppedCount` (and a small sample) into the gating audit record

## PR Title: Document audit for synthesis decisions and indexing failures

### Description

When a moment in the knowledge graph looks wrong, we can trace it back to the source document and micro-moment provenance, but we have not been able to inspect the macro synthesis output and the gating decisions that led to the moment being persisted. Separately, when indexing fails to produce moments, it has been hard to identify which documents failed without digging through logs.

This change persists document-level audit records for the moment generation pipeline and exposes them in both the UI and debug endpoints:

- Records macro synthesis events for both success and failure (prompt hash + truncated response preview).
- Records per-stream summaries and per-stream gating summaries, including the chosen link anchor macro and the query preview used for smart-linker attachment.
- Records indexing failures with a stage tag, plus micro-moment batch and embedding errors.
- Adds admin endpoints to fetch audit logs for a document and to list recent documents with audit events.
- Updates the knowledge graph audit UI to show document audit records and a “Recent failures” list with links to ingestion files.

This change also reduces graph noise by filtering out low-signal Discord coordination/status macro moments (afk, apology, sync, meeting/call, scheduling) unless the moment includes technical anchors. The filter can be tuned via `MACRO_MOMENT_DISCORD_NOISE_PATTERNS`.

Testing: `npm run build`

- Resolved a merge conflict in the audit actions module (document audit imports).
