# Issue #002 — Production build fails with duplicate symbols from server entry
**State:** Closed  
**Priority:** P0  
**Labels:** bug, build, vite, regression, alpha-4  
**Assignees:** @justinvdm  
**Milestone:** Alpha 4  
**Created:** 2025-09-16 15:11 (SAST)  
**Updated:** 2025-09-16 21:04 (SAST)

---
## Summary
Production deploy intermittently fails with duplicate symbol error (e.g., `renderRscToStream`).

## Root Cause
Vite optimizer inlined server entry twice; redundant export collided during prod build.

## Fix
- Mark server entry as external for prod build.
- Remove redundant export.
- Add regression test.

## Links
- PR: #752 — see pr-752-redwoodjs-sdk.md
- Standup notes: transcript-2025-09-16-radix-kickoff.md
- Slack: slack-2025-09-17-18-dev-rwsdk.md (11:09–11:10)

## Status
✅ Fixed and merged on 2025-09-16. Included in Alpha 4.
