# Issue #005 — Transcript segmentation: join out-of-order segments with soft close window
**State:** Open  
**Priority:** P2  
**Labels:** enhancement, transcripts, backend  
**Assignees:** @justinvdm  
**Milestone:** Investor Demo  
**Created:** 2025-09-17 13:41 (SAST)  
**Updated:** 2025-09-18 11:23 (SAST)

---
## Summary
Webhook retries and KV lag can deliver transcript segments out of order, leading to giant unsegmented blobs.

## Proposal
- Buffer segments in memory for 60s prior to persistence.
- Apply a five‑minute "soft close" window to append late segments.
- Deterministic sorting before commit; log boundary decisions.

## Evidence
- Slack: slack-2025-09-17-18-machinen-app.md (13:41 thread)
- AI note: ai-chat-2025-09-18-segmentation-buffering.md
- Transcript refs: transcript-2025-09-17-hydration-patch-and-machinen-sync.md

## Acceptance Criteria
- [ ] Segments arriving within 5 minutes merge into the correct conversation
- [ ] Clear logs explain split vs merge decisions
- [ ] Configurable windows but stable defaults for demo
