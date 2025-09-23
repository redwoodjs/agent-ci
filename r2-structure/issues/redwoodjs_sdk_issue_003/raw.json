# Issue #003 — <Link> prefetch mutates attributes during hydration
**State:** Open  
**Priority:** P2  
**Labels:** bug, hydration, routing, low-risk  
**Assignees:** @justinvdm  
**Milestone:** Post Alpha 4  
**Created:** 2025-09-17 16:21 (SAST)  
**Updated:** 2025-09-18 11:07 (SAST)

---
## Summary
Our `<Link>` prefetch logic mutates attributes during initial paint, racing with hydration on slow connections and causing warnings.

## Reproduction
1. Navigate to `/examples/link`.
2. Throttle to 3G Fast.
3. Soft-nav between links.

**Observed:** "Text content did not match" warning.  
**Expected:** No hydration warnings.

## Proposed Fix
Guard prefetch mutation with `typeof window !== 'undefined'` and defer via `requestIdleCallback` or after hydration commit.

## Evidence
- Slack note: slack-2025-09-17-18-dev-rwsdk.md (16:21–16:23, 2025-09-17)
- Transcript: transcript-2025-09-17-link-warning-triage.md
- Reload logs: observed-page-reloads-2025-09-17-18.md (16:13:37 shows warning pre‑guard; 11:07:44 next day clean)

## Acceptance Criteria
- [ ] No hydration warnings with throttled network
- [ ] Guarded mutation covered by unit test
