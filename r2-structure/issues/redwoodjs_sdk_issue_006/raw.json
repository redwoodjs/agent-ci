# Issue #006 — Buffer non-critical KV writes to smooth CI spikes
**State:** Open  
**Priority:** P3  
**Labels:** infra, kv, stability  
**Assignees:** @justinvdm  
**Milestone:** Post Alpha 4  
**Created:** 2025-09-17 08:22 (SAST)  
**Updated:** 2025-09-17 16:55 (SAST)

---
## Context
Metrics show KV write spikes during CI windows, potentially impacting downstream services (segmentation join timing).

## Proposal
- Queue non‑critical writes with backoff.
- Reduce log verbosity for hydration traces to `warn` level on staging.

## Links
- Slack infra: slack-2025-09-17-18-infra.md (08:22–08:25, 12:12–12:14, 16:55)
- Related: issue-005-transcript-segmentation-boundaries.md
