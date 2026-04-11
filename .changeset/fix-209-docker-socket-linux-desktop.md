---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Fix Docker socket bind mount on Linux + Docker Desktop when user is not in the docker group (#209). `resolveDockerSocket()` now treats `socketPath` (API client) and `bindMountPath` (container mount source) as independent decisions: whenever `/var/run/docker.sock` exists on the host, it is used as the bind-mount source regardless of our process's R/W access. This collapses the macOS Docker Desktop symlink case (#197) and the Linux Docker Desktop non-docker-group case (#209) into one rule.
