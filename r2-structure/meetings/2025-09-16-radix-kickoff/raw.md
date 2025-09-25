# Transcript: Radix Hydration — Kickoff
*(Conversation — 2025-09-16, internal call. Participants: Peter, Justin)*

**2025-09-16 09:13:57** Peter: Hey Justin, morning. Uh, quick one — any movement on that Radix hydration thing? People are, um, hitting it on Alpha 3.
**2025-09-16 09:14:22** Justin: Morning. Yeah, so I dug in last night. I think it's the `useId` path. Radix calls it in SSR and the counter… ah, the counter diverges on the client.
**2025-09-16 09:14:47** Peter: Right, so the IDs don't line up, hydration freaks out, classic. Does React 19 solve this automatically or are we stuck?
**2025-09-16 09:15:11** Justin: React 19 changes how `useId` seeds, but we’re on 18. I prototyped a deterministic wrapper — uh, basically seeding the same sequence for server and client.
**2025-09-16 09:15:40** Peter: Okay, so like… intercept `useId`? Or patch Radix directly?
**2025-09-16 09:16:03** Justin: I tried both. Patching Radix works but it’s brittle. Wrapper is cleaner for now, but I’m not thrilled. It’s… mm, it’s a band-aid.
**2025-09-16 09:16:28** Peter: Band-aids are fine if the site loads. We can ship the band-aid in Alpha 4 and then move to React 19 later.
**2025-09-16 09:16:54** Justin: Agreed. Also, just to be thorough — it's not only Radix; I saw a warning in our `<Head>` side-effect code when the doc renders twice. Might be a red herring though.
**2025-09-16 09:17:23** Peter: Hmm, okay. Can you write up the flow? Old render model vs the new stitched render thing you mentioned last week.
**2025-09-16 09:17:49** Justin: Yep. Old model was single pass. New model: isolate app render and document render, stream both, then stitch. That keeps `useId` counters aligned.
**2025-09-16 09:18:12** Peter: Cool. Oh — and, uh, can we log the exact Radix components that throw? Dropdown, Dialog, whatever?
**2025-09-16 09:18:34** Justin: Dialog, Popover, and a couple form controls. I’ll list them. Repros are reliable with hard reloads.
**2025-09-16 09:18:59** Peter: Perfect. Okay, ship plan is: doc, patch, test, and we keep the wrapper behind a flag if needed.
**2025-09-16 09:19:18** Justin: Works for me. I’ll push a branch and start drafting the notes now.
