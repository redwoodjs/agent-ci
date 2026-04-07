---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Fix: treat runner that never contacted DTU as a failure instead of success. When `isBooting` is still true after the container exits (meaning no timeline entries were received), the job is now correctly reported as failed regardless of exit code.
