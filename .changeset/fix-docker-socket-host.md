---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Use resolved DOCKER_HOST socket path for container bind mount instead of hardcoding /var/run/docker.sock.
