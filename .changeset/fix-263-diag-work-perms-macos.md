---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Fix `UnauthorizedAccessException` on `/home/runner/_diag` and workspace write failures when running on macOS with Colima or Docker Desktop (#263).

On those Docker backends the bind-mounted `_diag` and `_work` directories surface as `root:root 0755` inside the container because host permissions don't translate through the VM mount layer. The runner user (uid 1001) then can't write its diag logs or scratch files and the job crashes on startup. We now `MAYBE_SUDO chmod 1777` both mount points during container boot, mirroring the existing fix for `/home/runner/.cache` (#234). OrbStack and native Linux Docker are unaffected — the chmod is a no-op there.
