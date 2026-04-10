---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Fix Docker socket detection on Linux when /var/run/docker.sock exists but is not accessible (EACCES).
