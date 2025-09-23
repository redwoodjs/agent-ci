# Transcript: Duplicate Symbols — Hotfix Triage
*(Conversation — 2025-09-16, huddle. Participants: Peter, Justin)*

**2025-09-16 15:11:03** Justin: Quick context switch — I’m seeing duplicate symbol errors on the production build again. It’s blocking deploys.
**2025-09-16 15:11:21** Peter: Oh, that. Yeah, that killed Alpha 3. Uh, can we prioritize the hotfix? Hydration can wait a few hours.
**2025-09-16 15:11:49** Justin: Yep. I reproduced locally. Looks like Vite optimizer is inlining our server entry twice. The exports collide — specifically `renderRscToStream`.
**2025-09-16 15:12:18** Peter: So exclude the server entry? Or mark it external?
**2025-09-16 15:12:37** Justin: Marking as external in `vite.config` resolves it. I’ll also remove a redundant export we don’t need.
**2025-09-16 15:12:58** Peter: Okay, but let’s not break dev. If that setting only applies to prod, even better.
**2025-09-16 15:13:22** Justin: Yeah, I’ll gate it by build mode. Also adding a regression test so we don’t trip over this again.
**2025-09-16 15:13:44** Peter: Great. Ping me when CI is green.
**2025-09-16 21:03:11** Justin: Update — fix pushed. CI is passing, staging deploy looks clean.
**2025-09-16 21:03:36** Peter: Thanks, that unblocks us. I’ll tag it for Alpha 4.
