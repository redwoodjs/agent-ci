---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Fix `UnauthorizedAccessException` on `/home/runner/_diag` and workspace write failures when running on macOS with Colima or Docker Desktop (#263).

On those Docker backends the bind-mounted `_diag` and `_work` directories surface as `root:root 0755` inside the container because host permissions don't translate through the VM mount layer. The runner user (uid 1001) then can't write its diag logs or scratch files and the job crashes on startup. We now `MAYBE_SUDO chmod 1777` both mount points during container boot, mirroring the existing fix for `/home/runner/.cache` (#234). OrbStack and native Linux Docker are unaffected — the chmod is a no-op there.

Also hardens Docker socket detection: agent-ci now requires a working socket at `/var/run/docker.sock` (unless `DOCKER_HOST` is set explicitly) and fails fast with a link to a new per-provider setup guide (`packages/cli/docs/docker-socket.md`) instead of silently picking a provider-specific path that the mount layer later rejects. This eliminates a class of confusing "operation not supported" errors when switching Docker backends (e.g. leftover OrbStack symlinks on a Colima host).
