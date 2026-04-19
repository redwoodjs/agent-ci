---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Document and surface Docker Desktop's default-socket toggle. Docker Desktop 4.x ships with `/var/run/docker.sock` disabled, so a fresh install will hit `agent-ci couldn't use a Docker socket at /var/run/docker.sock` even when Docker Desktop is running. The `docker-socket.md` recipe now walks through the Settings → Advanced toggle, and the resolver error appends a one-shot hint pointing at it whenever it detects Docker Desktop's user-side socket (`~/.docker/run/docker.sock`).

Closes #253.
