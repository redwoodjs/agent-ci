# Issue #001 — Hydration mismatch with useId in React + Radix components
**State:** Open  
**Priority:** P1  
**Labels:** bug, SSR, RSC, radix-ui, alpha-4  
**Assignees:** @justinvdm  
**Milestone:** Alpha 4  
**Created:** 2025-09-17 10:29 (SAST)  
**Updated:** 2025-09-18 09:14 (SAST)

---
## Summary
Hydration warnings in Radix components (`Dialog`, `Popover`, `Tooltip`) due to non‑deterministic `React.useId` across SSR and client.

## Reproduction
1. Build and run the `examples/radix-hydration-repro` app.
2. Hard reload the page.
3. Open Radix Dialog with keyboard (Enter/Space).
4. Optionally, throttle to 3G Fast to increase likelihood.

**Observed:** `Warning: Prop id did not match` and occasional discard of server DOM.  
**Expected:** No hydration mismatch; interactivity preserved.

## Environment
- React 18.x
- Browser: Chrome 126, Firefox 143
- RedwoodSDK (pre‑patch): single‑pass SSR
- Runtime: Workers/Miniflare

## Notes
- See slack-2025-09-17-18-dev-rwsdk.md, thread on 10:29.  
- Page reloads: observed-page-reloads-2025-09-17-18.md (entries at 10:34:51, 10:35:29, 11:18:12, 16:12:04, 16:12:52).  
- AI analysis: ai-chat-2025-09-17-radix-hydration.md.  
- Architecture change proposed in PR: pr-752-redwoodjs-sdk.md.

## Acceptance Criteria
- [ ] No hydration mismatch in Radix Dialog/Popover/Tooltip under repro conditions.
- [ ] Deterministic `useId` wrapper behind feature flag `deterministicUseId` (default on).
- [ ] Docs include short “Why this happened” note and React 19 migration path.

## Tasks
- [x] Implement isolation + stream stitching (server) — see PR #752
- [x] Add deterministic `useId` wrapper (temporary)
- [ ] Write docs & changelog
- [ ] Verify on throttled network + keyboard open
