---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Fix signal handler to clean up runner directory on Ctrl+C. Add parent-PID liveness tracking to detect and kill orphaned Docker containers on startup. Wire up pruneStaleWorkspaces to clean up old run directories.
