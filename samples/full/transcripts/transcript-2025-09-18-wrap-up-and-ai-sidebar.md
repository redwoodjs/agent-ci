# Transcript: Wrap‑up + AI Sidebar Overlap
*(Conversation — 2025-09-18, morning check-in. Participants: Peter, Justin)*

**2025-09-18 08:56:43** Justin: Morning. Quick recap — Radix `useId` wrapper is in, notes written, and the isolation + stream stitch approach is documented.
**2025-09-18 08:57:06** Peter: Great. Uh, ah, can we put that behind a feature flag called `deterministicUseId`? Just in case someone wants to opt out.
**2025-09-18 08:57:29** Justin: Yep, already added. Default on.
**2025-09-18 08:57:51** Peter: Nice. Different bug — Machinen’s AI sidebar. I’m getting overlapping prompts when I hit enter twice. It queues duplicates.
**2025-09-18 08:58:17** Justin: That’s probably the debounce in the input handler. It fires on keyup and on submit. I can consolidate to a single dispatch.
**2025-09-18 08:58:44** Peter: Cool. And — uh — let’s log the prompt UUID at the edge so we can dedupe.
**2025-09-18 08:59:08** Justin: Good call. I’ll put a short-term guard in the client and a server-side idempotency check.
**2025-09-18 08:59:33** Peter: Perfect. Anything else on hydration we should tell people about?
**2025-09-18 08:59:55** Justin: Just that React 19 will make this cleaner, and we’ll remove the wrapper once we bump. I’ll open a tracking issue.
**2025-09-18 09:00:18** Peter: Sounds good. Thanks.
