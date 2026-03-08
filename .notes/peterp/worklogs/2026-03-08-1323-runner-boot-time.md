---
title: Runner boot time investigation
date: 2026-03-08 13:23
author: peterp
---

# Runner boot time investigation

## Summary

Investigated the 13.8s "Starting runner" boot time. The bottleneck is the .NET 6 JIT cold start inside the container (~8-10s). Parallelized host-side prep to overlap with container startup. Attempted to remove the DTU proxy and simplify the entrypoint but both had to be reverted.

## The Problem

Runner boot takes ~13.8s before any job step starts:

```
tests.yml (22.4s)
├── Starting runner (13.8s)
└── test
    ├── [✓] Set up job (4s)
    ...
```

## Investigation & Timeline

- **Initial State:** Boot spans from container creation through .NET `run.sh --once` cold start. Four phases: host prep (~1-2s), container create/start (~1-2s), entrypoint setup (~1-2s), .NET JIT (~8-10s).
- **Attempts:**
  - **Parallelized host prep** — moved `prepareWorkspace()` + `writeGitShim()` to run concurrently with `container.start()` via `Promise.all`. ✅ Worked.
  - **Removed DTU proxy** — pointed credentials directly at `host.docker.internal:<port>` to eliminate the Node.js TCP proxy. ❌ `actions/checkout` makes real HTTP requests to `127.0.0.1:80`; proxy is architecturally required.
  - **Tried socat** as a lighter proxy. ❌ Not available in the `actions-runner` image.
  - **Simplified entrypoint** — removed `MAYBE_SUDO`, redundant `chmod -R 777`, `mkdir -p`, echo. ❌ Container hung; the bash `&&` chain is fragile.

## Discovery & Key Findings

- The `.NET 6` runner (`Runner.Listener` + `Runner.Worker`) JIT compiles from scratch every container start — this ~8-10s cost cannot be cached via `docker commit` (JIT state is in-process memory).
- The in-container proxy on `127.0.0.1:80` is required because `actions/checkout` constructs URLs from `GITHUB_SERVER_URL` and makes HTTP git-transport requests. The git shim only intercepts `/usr/bin/git`, not the underlying HTTP helpers.
- `initFakeGitRepo` sets the remote to `http://127.0.0.1/${repo}` (no port — port 80 is default). `actions/checkout` compares this via `URL.origin` which strips `:80`. Any URL mismatch causes a full workspace wipe + re-clone.

## Resolution

Only optimization 1 survived: `prepareWorkspace()` + `writeGitShim()` + host-side `chmod -R 777` run in parallel with container creation via `Promise.all([container.start(), workspacePrepPromise])` in `local-job.ts`.

## Next Steps

- [ ] Implement keep-alive runner container (eliminate .NET cold start entirely, ~10s savings)
- [ ] Install `socat` in a custom runner image to replace the Node.js proxy
- [ ] Explore .NET `PublishReadyToRun` / CrossGen2 for the runner binaries
