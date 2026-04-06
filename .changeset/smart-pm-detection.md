---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Detect project package manager and only mount relevant PM cache directories into the container. Projects using npm, yarn, or bun no longer get unnecessary pnpm store bind mounts (and vice versa). Falls back to mounting all PM caches when no lockfile is detected.
