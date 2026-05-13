# agent-ci — Domain Glossary

Living document. Add terms as they're resolved during design discussions.

## Terms

### Runtime

The container/VM layer where a job's compute runs. agent-ci ships three:

- **`docker`** — runs the job in a Linux container via Dockerode.
- **`macos-vm`** — runs the job in an Apple Virtualization.framework VM via `tart`.
- **`machinen`** — runs the job in an arm64 Linux microVM via `@machinen/runtime`.
  Installed as an `optionalDependency`, so it only resolves on supported
  platforms (arm64 darwin/linux) and is absent elsewhere.

**Selection.** A Runtime is selected per-job based on the job's `runs-on:`
OS family, host capability, and user preference. Priority order (first
matching supported runtime wins): `machinen`, `macos-vm`, `docker`.
That means on an arm64 mac/linux host with machinen installed, `linux`
jobs default to machinen; elsewhere they fall back to docker.

**`AGENT_CI_RUNTIME` env var.** Overrides priority _within the candidate
set for the job's OS family_. It is not an override of OS classification:
setting `AGENT_CI_RUNTIME=docker` on a `runs-on: macos-15` job does not
force docker — docker doesn't support macOS, so the job is skipped with
the existing unsupported-OS warning.

**Runtime interface.** Each runtime exposes:

- `name` — registry key, AGENT_CI_RUNTIME value, and short display label.
- `checkHost(): Promise<HostCapability>` — probed once per run at startup,
  result cached.
- `supportsJob(kind: RunnerOSKind): boolean` — does this runtime handle
  that OS family?
- `execute(job, opts): Promise<JobResult>` — opts are advisory; a runtime
  may ignore fields it doesn't honor (e.g. macos-vm currently ignores
  `pauseOnFailure` and `store`).

**Not to be confused with:**

- **Runner** — the GitHub Actions runner binary (`run.sh`) and its on-disk
  install. A runtime _hosts_ a runner; they are not the same thing.
- **Host** — the physical machine agent-ci runs on. `checkMacosVmHost()`
  asks "can this host launch a macos-vm runtime?".

### machinen rootfs

The Linux arm64 rootfs that machinen boots a job into. Baked locally on
the user's machine the first time a machinen job runs, cached in
`~/.cache/agent-ci/machinen/`. The bake uses `provision()` from
`@machinen/runtime` and installs a pinned set of packages: `nodejs`,
`git`, `curl`, `ca-certificates`, `build-essential`, plus the GHA runner
binary (pinned SHA). `run.sh`, workspace, and DTU credentials are
injected per-job, not baked.

The pre-baked-on-GitHub-Releases strategy (mirroring cirruslabs' tart
images) is a follow-up — we can flip `image-mapping.ts` to point at
release URLs later without touching the Runtime interface.

### Workspace (run-dir)

All runtimes share the existing `prepareWorkspace` (in `runner/workspace.ts`):
the user's repo is copied — APFS CoW on macOS, rsync on Linux — into
`<runDir>/work/<repoName>/<repoName>/`, respecting `.gitignore` so
`node_modules` is excluded from the initial copy. The bind/live-mount
target for each runtime is the **run dir**, not the user's working repo.

- **docker** bind-mounts the run dir into the container at
  `/github/workspace`.
- **macos-vm** rsyncs the run dir into the VM (tart has no shared-fs
  option).
- **machinen** FUSE-over-vsock live-mounts the run dir into the guest
  at `/github/workspace`. Same isolation semantics as docker: edits to
  the user's repo do not appear in the VM until `syncWorkspaceForRetry`
  re-syncs them; `node_modules` installed by a job lands in the run dir
  (linux-arm64 binaries), not the user's IDE-facing repo.
