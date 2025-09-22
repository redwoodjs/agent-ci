# Issue #004 — AI sidebar: duplicate prompt submissions on Enter + submit
**State:** Closed  
**Priority:** P1  
**Labels:** bug, ai, ui, idempotency  
**Assignees:** @justinvdm  
**Milestone:** Investor Demo  
**Created:** 2025-09-17 17:12 (SAST)  
**Updated:** 2025-09-18 09:06 (SAST)

---
## Summary
Pressing Enter can fire both keyup and submit handlers, enqueueing duplicate prompts in the AI sidebar.

## Fix
- Consolidate to a single submit path on client.
- Generate `prompt_uuid` per submission.
- Server rejects duplicates with same UUID within 30 seconds (KV TTL).
- Log UUID at edge for tracing.

## Evidence
- Slack: slack-2025-09-17-18-machinen-app.md (17:12–17:16; 09:06 next day)
- AI design note: ai-chat-2025-09-17-idempotency-prompts.md

## Status
✅ Shipped on 2025-09-18.
