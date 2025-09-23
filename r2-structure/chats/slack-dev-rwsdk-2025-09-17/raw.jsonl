# Slack Channel: #dev-rwsdk
*(Two-day segment · 2025-09-17 → 2025-09-18 · Times are SAST)*

## 2025-09-17

**10:29:11** — **Peter:** Picking up Radix hydration again. Anyone still seeing `Warning: Prop id did not match` on hard reload? Repros welcome.
**10:31:03** — **Justin:** Yes. Dialog and Popover still throw on first render. I have a deterministic `useId` wrapper that stabilizes IDs server vs client.
**10:31:46** — **Amy:** Do we have a minimal repro app I can run on my side? Network throttling can make it worse.
**10:32:12** — **Justin:** I’ll push a tiny example after lunch. It isolates the Radix bits.
**10:33:20** — **Peter:** Cool. Also saw a separate hydration warning in our `<Link>` component. Might be unrelated.
**10:34:02** — **Justin:** Logged. Likely due to prefetch attribute mutating during hydration. Guarding it behind `typeof window !== 'undefined'` should help.
**10:38:15** — **Peter:** For Radix: let’s ship the wrapper now and document the React 19 path.
**11:05:44** — **Justin:** Noted. Wrapper lives in `packages/web/useIdDeterministic.ts`. Short-term band‑aid only.
**11:06:09** — **Amy:** Please add a unit test that asserts stable IDs across SSR/CSR for two components rendered in different trees.
**11:09:31** — **Justin:** Will do. Also, PR #752 from yesterday fixed duplicate symbols on prod builds.
**11:10:02** — **Peter:** Great. Tagging both fixes for Alpha 4 notes.

**Thread on 10:29:11**
↳ **11:17:52** — **Amy:** On my machine, Popover mismatch only shows when I reload twice, then open with keyboard. Worth adding to repro steps.
↳ **11:19:08** — **Justin:** Good catch. I’ll include that.

**15:42:28** — **Peter:** Quick heads-up: I’m going offline for a school pickup around 16:30. Ping me if the repro lands before then.
**16:07:14** — **Justin:** Repro pushed: `examples/radix-hydration-repro` with throttled 3G profile steps.

## 2025-09-18

**08:55:03** — **Justin:** Morning. Wrapper is behind feature flag `deterministicUseId` (default on). Docs in the worklog.
**08:56:12** — **Peter:** Thanks. Can we add a console hint pointing to the docs when the flag is turned off and a mismatch is detected?
**08:57:21** — **Justin:** Yes, adding a warning guard around typical Radix components.
**09:13:49** — **Amy:** Any regressions in non‑Radix apps?
**09:14:22** — **Justin:** None so far. Our example suite passes with and without the flag.
**11:02:36** — **Peter:** Let’s close the loop with a short “Why this happened” section in the changelog. Keep it light but clear.
**11:05:50** — **Justin:** Added: previous single‑pass SSR advanced `useId` differently than client; isolation + stream stitching keeps counters aligned.
