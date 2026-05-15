---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

chore(deps): bump @machinen/runtime to 0.3.3

Upgrades the optional machinen runtime dependency from 0.1.1 to 0.3.3.
The 0.3 line replaces the prior FUSE-over-vsock live-mount with
virtio-fs, which removes the per-file-operation RPC into Node and lets
real CI workloads (tar extracts, `pnpm install`, `actions/setup-node`)
run at native speed inside the microVM.

Several regressions surfaced during integration with this repo and
were fixed upstream before this bump:

- 0.3.1 — virtio-fs returned EIO on writes that opened an existing
  file with O_TRUNC / O_APPEND, on `cp` over an existing file, and on
  `rename()` (the latter returned ENOSYS).
- 0.3.2 — Node `fs.rm({ recursive: true })` cleanup hit EIO during
  rmdir of populated directories (observed via
  `actions/checkout`'s post-step cleanup).
- 0.3.3 — `readlink` returned ENOSYS (observed via
  `actions/setup-node`'s extraction of the Node tarball, which
  contains a `bin/corepack` symlink), `link()` for hardlinks returned
  ENOSYS, and `chmod +x` didn't propagate the execute bit so newly
  created scripts couldn't be run.

Verified end-to-end: `AGENT_CI_MACHINEN=1 agent-ci run --workflow
.github/workflows/tests.yml` boots the microVM, runs the full agent-ci
test suite inside it, and completes in 3m21s.
