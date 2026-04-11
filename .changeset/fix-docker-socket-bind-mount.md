---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Fix Docker socket bind-mount failure on macOS Docker Desktop (#197).

When `/var/run/docker.sock` is a symlink (common with Docker Desktop), the resolved real path was being used as the container bind-mount source. Docker's VM cannot access that host path, causing "error while creating mount source path". Now `resolveDockerSocket()` returns a separate `bindMountPath` (the pre-symlink path, e.g. `/var/run/docker.sock`) for use in bind mounts, while `socketPath` (the resolved path) continues to be used for the Docker API client connection.
