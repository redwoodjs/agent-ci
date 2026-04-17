---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

fix: docker/setup-buildx-action and other Docker socket users fail with "permission denied" on native Linux Docker (#257)

The runner container's entrypoint chmods the bind-mounted `/var/run/docker.sock` to `0666` so the `runner` user can talk to the Docker daemon. On native Linux Docker the socket is owned `root:docker`, so the chmod needs `sudo` — but it was using plain `chmod` and silently failing. Steps like `docker/setup-buildx-action@v4`, `docker login`, and `docker compose` then failed with `permission denied while trying to connect to the docker API at unix:///var/run/docker.sock`. Now escalated via `MAYBE_SUDO`, matching the other privileged entrypoint operations.
