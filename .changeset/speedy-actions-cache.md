---
"@redwoodjs/agent-ci": minor
"dtu-github-actions": minor
---

Cache action tarballs on first download and serve from disk on subsequent runs, eliminating ~30s GitHub CDN delays. Capture step output via tee to signals dir for reliable pause-on-failure tail display. Fix CLI to treat empty results as failure.
