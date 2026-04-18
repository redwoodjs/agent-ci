# dtu-github-actions

## 0.12.0

### Minor Changes

- 12220be: Run `runs-on: macos-*` jobs in a real macOS VM via [tart](https://github.com/cirruslabs/tart) on Apple Silicon hosts.

  When the host is `darwin`/`arm64` with `tart` and `sshpass` installed, jobs whose `runs-on:` targets macOS launch a cirruslabs macOS VM, rsync in the macOS `actions-runner` binary, and connect the runner to the ephemeral DTU via the host bridge. Concurrency is capped at 2 VMs by default (override with `AGENT_CI_MACOS_VM_CONCURRENCY`).

  Hosts that don't support this (Linux, Intel macOS, missing tart/sshpass) continue to skip macOS jobs with the same warning introduced in #273. Windows jobs are still skipped on all hosts.

  Image mapping:
  - `macos-13` → `macos-ventura-xcode:latest`
  - `macos-14` → `macos-sonoma-xcode:latest`
  - `macos-15` → `macos-sequoia-xcode:latest`
  - `macos-26` → `macos-tahoe-xcode:latest`
  - `macos` / `macos-latest` → `macos-sonoma-xcode:latest`
  - Override with `AGENT_CI_MACOS_VM_IMAGE`.

## 0.11.0

### Minor Changes

- 9474fb5: Skip jobs with `runs-on: macos-*` or `windows-*` instead of silently running them in a Linux container

  Previously, jobs targeting macOS or Windows runners were silently routed to the Linux runner container and failed at the first OS-specific step (e.g. `Setup Xcode`), producing a confusing error. They now skip with a visible `[Agent CI]` warning that points at the tracking issues for real support. Linux and `self-hosted`-without-OS-hint jobs are unaffected.

  Tracking:
  - https://github.com/redwoodjs/agent-ci/issues/254 (this guardrail)
  - https://github.com/redwoodjs/agent-ci/issues/258 (real macOS runner support)

- 2bb4e57: Add support for `${{ vars.FOO }}` expressions in local workflow runs. Supply vars via the `--var KEY=VALUE` CLI flag (repeat for multiple). Runs fail with a clear error listing the missing vars if any required var is not provided.

### Patch Changes

- b6b9310: fix: docker/setup-buildx-action and other Docker socket users fail with "permission denied" on native Linux Docker (#257)

  The runner container's entrypoint chmods the bind-mounted `/var/run/docker.sock` to `0666` so the `runner` user can talk to the Docker daemon. On native Linux Docker the socket is owned `root:docker`, so the chmod needs `sudo` — but it was using plain `chmod` and silently failing. Steps like `docker/setup-buildx-action@v4`, `docker login`, and `docker compose` then failed with `permission denied while trying to connect to the docker API at unix:///var/run/docker.sock`. Now escalated via `MAYBE_SUDO`, matching the other privileged entrypoint operations.

- 372a47b: Support `env:` at workflow and job level (not just step level).

  Previously the workflow parser only read `env:` declared directly on a step. Workflow-level and job-level `env:` blocks were silently ignored, so any workflow that relied on them — including workflows that referenced `${{ vars.X }}` in a job-level env — saw empty values at runtime.

  The parser now merges `env:` from all three levels per the GitHub Actions spec: workflow → job → step, step-most-specific wins. Expressions (including `${{ vars.X }}`, `${{ secrets.X }}`, etc.) are expanded per-level.

  This also makes the `smoke-vars-preflight.yml` Case 3 assertion actually verify the feature it documents — previously the assertion depended on env leaking in from the outer runner process.

- 3b16523: Improve error hints when fetching remote reusable workflows from private repositories. GitHub returns HTTP 404 (not 401/403) when authentication is missing or insufficient for a private repo — to avoid leaking repo existence — so the 404 path now emits the same auth guidance as the 401/403 path, including instructions to run `gh auth login` and use `--github-token`. The hint also distinguishes between the no-token case (how to provide one) and the token-provided case (scope / fine-grained permission / SSO authorization may be missing).

## 0.10.7

### Patch Changes

- e482875: Fix `actions/setup-node` emitting "Bad credentials" and falling back to a slow nodejs.org download. The bundled `@actions/tool-cache` hardcodes `api.github.com` for its versions-manifest fetch; the DTU now rewrites the URL in setup-node's tarball at cache time and mocks the `/repos/:owner/:repo/git/trees|blobs` endpoints so the manifest call routes through the DTU (fixes #249).

  Also: when a step fails with `tar: ...: Cannot open: Permission denied` (typically from a stale `/opt/hostedtoolcache` bind mount left by a previous run), surface an actionable hint showing the host-side toolcache path and an `rm -rf` command to clear it (fixes #171).

## 0.10.6

### Patch Changes

- 64d654d: Auto-pull runner image on first run with visible progress output. Previously, first-time users saw a frozen spinner or a confusing "No such image" error because the pull happened silently and failures were only debug-logged.

## 0.10.5

### Patch Changes

- 2e2bd5e: fix: always show workflows and jobs in --all mode, fix duplicate matrix jobs

## 0.10.4

### Patch Changes

- 25c1c5d: Fix Cypress install failing with EACCES on `/home/runner/.cache/Cypress`.

## 0.10.3

### Patch Changes

- ca4610f: Fix expression evaluation in workflow parser to support boolean operators (`&&`, `||`, `!`), `format()`, and `toJSON()`.

## 0.10.2

### Patch Changes

- 37d6125: Fix nested agent-ci crashes and add global concurrency limiter.
  - Skip orphan cleanup when running inside a container (`.dockerenv` detection) to prevent nested agent-ci from killing its own parent container.
  - Resolve DTU host from the container's own IP when nested, instead of inheriting the unreachable `AGENT_CI_DTU_HOST`.
  - Add a shared concurrency limiter across all workflows in `--all` mode, auto-detected from Docker VM memory (`floor(availableMemory / 4GB)`), to prevent OOM kills (exit 137).

## 0.10.1

### Patch Changes

- 71a3ebb: Exclude test files from published dist by adding tsconfig exclude for `*.test.ts`.

## 0.10.0

### Minor Changes

- 66ac2a4: Add pluggable runner image via `.github/agent-ci.Dockerfile` convention (#208).

  agent-ci now discovers a user-provided Dockerfile at `.github/agent-ci.Dockerfile` (or `.github/agent-ci/Dockerfile` for builds with a COPY context), hashes its contents, builds it locally via `docker build`, and uses the resulting `agent-ci-runner:<hash>` tag as the default runner image. Edits to the Dockerfile produce a new hash and trigger an automatic rebuild; identical contents reuse the cached image.

  This closes the long-standing gap where the minimal `ghcr.io/actions/actions-runner:latest` image lacks `build-essential`, `python3`, and other toolchains that GitHub's hosted `ubuntu-latest` VM ships preinstalled. Workflows that run green on GitHub but fail locally with `linker 'cc' not found` or similar can now opt into a richer image by dropping a 5-line Dockerfile into `.github/`.

  Resolution order (highest wins):
  1. Per-job `container:` directive (unchanged)
  2. `AGENT_CI_RUNNER_IMAGE` environment variable
  3. `.github/agent-ci/Dockerfile` (directory form, supports COPY)
  4. `.github/agent-ci.Dockerfile` (simple form, empty context)
  5. `ghcr.io/actions/actions-runner:latest` (unchanged default)

  Also adds an error-hint heuristic: when a step fails with a "command not found" pattern for common tools (`cc`, `gcc`, `make`, `python3`, `pkg-config`) and the user is still on the default image, the failure summary includes a ready-to-paste Dockerfile snippet pointing at the fix. See `packages/cli/runner-image.md` for full documentation.

### Patch Changes

- 1c7e663: Fix Docker socket bind mount on Linux + Docker Desktop when user is not in the docker group (#209). `resolveDockerSocket()` now treats `socketPath` (API client) and `bindMountPath` (container mount source) as independent decisions: whenever `/var/run/docker.sock` exists on the host, it is used as the bind-mount source regardless of our process's R/W access. This collapses the macOS Docker Desktop symlink case (#197) and the Linux Docker Desktop non-docker-group case (#209) into one rule.
- 38994c8: Fix service container and runner leak on unclean shutdown.
- 1a92bbd: Fix Docker socket bind-mount failure on macOS Docker Desktop (#197).

  When `/var/run/docker.sock` is a symlink (common with Docker Desktop), the resolved real path was being used as the container bind-mount source. Docker's VM cannot access that host path, causing "error while creating mount source path". Now `resolveDockerSocket()` returns a separate `bindMountPath` (the pre-symlink path, e.g. `/var/run/docker.sock`) for use in bind mounts, while `socketPath` (the resolved path) continues to be used for the Docker API client connection.

- cf18585: perf: hoist docker cleanup and image prefetch to session bootstrap

  `agent-ci run --all` now runs global Docker cleanup (prune orphans, kill
  stale containers, prune stale workspaces) and runner image prefetch exactly
  once per session instead of once per workflow. Also dedupes concurrent
  `ensureImagePulled` calls so parallel workflows share a single in-flight
  `docker pull`. Eliminates cold-start thundering herd and the N× `docker
volume prune` storm that was serializing multi-workflow runs. See #211.

- 38994c8: fix: use XDG cache dir on Linux + Docker Desktop instead of /tmp (#215)

## 0.9.0

### Minor Changes

- b93ecdf: Compute dirty SHA for uncommitted worktrees so `github.sha` reflects the code actually being executed.
- 2cf4034: Resolve workflow secrets from shell environment variables (fallback to .env.agent-ci file). Also auto-populate `secrets.GITHUB_TOKEN` from `--github-token`.

### Patch Changes

- 1e2714b: Fix "No such image" error on first run for users without a local Docker image cache.
- 9ff0710: Deduplicate identical failure errors in output summary and streaming messages.
- 68b1d14: Show failure output and retry/abort hints for paused jobs in multi-job workflows.

## 0.8.2

### Patch Changes

- f7e42f0: Fix signal handler to clean up runner directory on Ctrl+C. Add parent-PID liveness tracking to detect and kill orphaned Docker containers on startup. Wire up pruneStaleWorkspaces to clean up old run directories.
- cd24a04: Fix actions/checkout@v6 compatibility by using the real HEAD SHA instead of a fake placeholder.
- e42f4a9: Fix Docker socket detection on Linux when /var/run/docker.sock exists but is not accessible (EACCES).
- 02741dc: Mount warm node_modules directly at workspace path instead of symlinking via /tmp

## 0.8.1

### Patch Changes

- 1f24fec: Make GitHub authentication opt-in for remote reusable workflow fetching. Add --github-token CLI flag and AGENT_CI_GITHUB_TOKEN env var.

## 0.8.0

### Minor Changes

- f660c11: Support composite action step outputs and push event context for changed-files actions
- ba84b69: Add ts-runner: a TypeScript replacement for the GitHub Actions runner that executes workflow `run:` steps natively without Docker.
- 6b7a95b: Support local composite actions (`uses: ./.github/actions/...`) by setting `RepositoryType: "self"` so the runner resolves them from the workspace.
- cf31ce1: Support nested reusable workflows up to 4 levels deep, matching GitHub Actions' limit.
- e9c5df5: Support local reusable workflows (`uses: ./.github/workflows/...`) by inlining called jobs into the caller's dependency graph.
- 789e403: Support passing inputs and outputs through reusable workflows. Caller `with:` values are now resolved and available as `inputs.*` in called workflows, input defaults from `on.workflow_call.inputs` are respected, and `on.workflow_call.outputs` are wired back so downstream jobs can consume `needs.<callerJobId>.outputs.*`.

### Patch Changes

- c7d45a2: Use resolved DOCKER_HOST socket path for container bind mount instead of hardcoding /var/run/docker.sock.
- 7a612b0: Fix duplicate error messages on workflow failure by removing the intermediate console.error in handleWorkflow's catch block.
- fbd8dea: Fix horizontal scrolling on code blocks in mobile in-app browsers (e.g. Twitter/X).
- 8fbe36d: Fix TypeScript @types resolution for pnpm projects using warm-modules cache.
- 81aedf3: Fix stderr leak from git commands and support non-origin remote names.
- 912ed83: Preserve git-tracked symlinks in workspace snapshot copies.
- 2820b5a: Remove test script from ts-runner package to unblock release workflow.
- 1b1c664: Guard against undefined template.jobs from workflow parser to prevent TypeError crash.
- ed4e86c: Fix parseWorkflowSteps crash when template.jobs is undefined.

## 0.7.1

### Patch Changes

- 17ef340: Fix --all hanging on single-job workflows due to cross-workflow job stealing.

  Pin `job.runnerName = containerName` before the DTU seed call so every job goes to the runner-specific pool. Move container and ephemeral DTU cleanup into a `finally` block to ensure cleanup even on mid-run errors. Set `process.setMaxListeners(0)` to suppress EventEmitter warnings when running many parallel jobs.

- 336fb98: Fix: treat runner that never contacted DTU as a failure instead of success. When `isBooting` is still true after the container exits (meaning no timeline entries were received), the job is now correctly reported as failed regardless of exit code.
- cc73a1f: Fix race condition in concurrent log directory allocation by using atomic mkdirSync.
- be5cacd: Fix handleWorkflow catch block swallowing errors by re-throwing instead of returning empty array
- 5fadfee: Remove stopped agent-ci containers before pruning networks to prevent address pool exhaustion.
- 1e9d7ca: Support `pull_request_target` in workflow relevance check, applying the same branch and paths filter logic as `pull_request`. Fix Docker container name collisions when running multiple workflows concurrently via `--all` by pre-allocating unique run numbers per workflow.
- 73f6bf0: Propagate job-level env into DTU Variables store and add AGENT_CI_LOCAL to Docker container env.

## 0.7.0

### Minor Changes

- c2fe31b: Cache action tarballs on first download and serve from disk on subsequent runs, eliminating ~30s GitHub CDN delays. Capture step output via tee to signals dir for reliable pause-on-failure tail display. Fix CLI to treat empty results as failure.
- acb750f: Show Docker image pull progress (bytes downloaded / total) as a sub-step under "Starting runner" during boot.

### Patch Changes

- f9f17fd: Detect project package manager and only mount relevant PM cache directories into the container. Projects using npm, yarn, or bun no longer get unnecessary pnpm store bind mounts (and vice versa). Falls back to mounting all PM caches when no lockfile is detected.

## 0.6.0

### Minor Changes

- 6e53753: Post GitHub commit status via gh CLI after agent-ci run completes

### Patch Changes

- d273b76: Show full per-step log content in failure summary instead of a truncated 20-line tail.
- a987818: Simplify Docker host resolution to be OS-agnostic by default, with explicit environment-variable overrides for custom networking setups.

## 0.5.0

### Minor Changes

- 179405b: Add package metadata, SKILL.md, and AI agent discoverability section to README

## 0.4.0

### Minor Changes

- 61d3e25: Add --no-matrix flag to collapse matrix workflows into a single job.

## 0.3.4

## 0.3.3

### Patch Changes

- fix(dtu): replace execa with node:child_process to fix production runtime error

## 0.3.2

## 0.3.1

## 0.3.0

### Patch Changes

- 9b34858: Fix race condition in `--all` mode where a runner could steal another runner's job from the generic pool, causing the original runner to spin indefinitely.

## 0.2.0

### Minor Changes

- 7bce818: Initial release.
