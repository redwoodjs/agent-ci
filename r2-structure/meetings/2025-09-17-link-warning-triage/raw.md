# Transcript: Link Hydration Warning — Quick Triage
*(Conversation — 2025-09-17, quick sync. Participants: Peter, Justin)*

**2025-09-17 16:21:09** Justin: So, ah, small thing — I also saw a hydration warning in our `<Link>` component. Different path from Radix.
**2025-09-17 16:21:31** Peter: Different how?
**2025-09-17 16:21:47** Justin: Our link prefetch logic mutates attributes after the first paint. It’s racing with hydration on slow networks.
**2025-09-17 16:22:12** Peter: Can we defer that to `requestIdleCallback` or something? Or just no-op on the server render?
**2025-09-17 16:22:36** Justin: Yeah, I’ll guard it with `typeof window !== 'undefined'` and schedule it after hydration. It’s a one-liner.
**2025-09-17 16:22:58** Peter: Cool. Let’s not let this snowball. File an issue and punt to after Alpha 4 unless it’s user-facing.
**2025-09-17 16:23:20** Justin: Will do. I’ll add a note in the worklog too.
