---
"dtu-github-actions": patch
---

Fix race condition in `--all` mode where a runner could steal another runner's job from the generic pool, causing the original runner to spin indefinitely.
