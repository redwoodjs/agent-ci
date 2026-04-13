# @redwoodjs/agent-ci

## 0.10.4

### Patch Changes

- Fix Cypress install failing with EACCES on `/home/runner/.cache/Cypress` (#234).

## 0.10.3

### Patch Changes

- ca4610f: Fix expression evaluation in workflow parser to support boolean operators (`&&`, `||`, `!`), `format()`, and `toJSON()`.
- Updated dependencies [ca4610f]
  - dtu-github-actions@0.10.3

## 0.10.2

### Patch Changes

- 37d6125: Fix nested agent-ci crashes and add global concurrency limiter.
  - Skip orphan cleanup when running inside a container (`.dockerenv` detection) to prevent nested agent-ci from killing its own parent container.
  - Resolve DTU host from the container's own IP when nested, instead of inheriting the unreachable `AGENT_CI_DTU_HOST`.
  - Add a shared concurrency limiter across all workflows in `--all` mode, auto-detected from Docker VM memory (`floor(availableMemory / 4GB)`), to prevent OOM kills (exit 137).

- Updated dependencies [37d6125]
  - dtu-github-actions@0.10.2

## 0.10.1

### Patch Changes

- 71a3ebb: Exclude test files from published dist by adding tsconfig exclude for `*.test.ts`.
- Updated dependencies [71a3ebb]
  - dtu-github-actions@0.10.1

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
- Updated dependencies [1c7e663]
- Updated dependencies [38994c8]
- Updated dependencies [1a92bbd]
- Updated dependencies [cf18585]
- Updated dependencies [66ac2a4]
- Updated dependencies [38994c8]
  - dtu-github-actions@0.10.0

## 0.9.0

### Minor Changes

- b93ecdf: Compute dirty SHA for uncommitted worktrees so `github.sha` reflects the code actually being executed.
- 2cf4034: Resolve workflow secrets from shell environment variables (fallback to .env.agent-ci file). Also auto-populate `secrets.GITHUB_TOKEN` from `--github-token`.

### Patch Changes

- 1e2714b: Fix "No such image" error on first run for users without a local Docker image cache.
- 9ff0710: Deduplicate identical failure errors in output summary and streaming messages.
- 68b1d14: Show failure output and retry/abort hints for paused jobs in multi-job workflows.
- Updated dependencies [b93ecdf]
- Updated dependencies [2cf4034]
- Updated dependencies [1e2714b]
- Updated dependencies [9ff0710]
- Updated dependencies [68b1d14]
  - dtu-github-actions@0.9.0

## 0.8.2

### Patch Changes

- f7e42f0: Fix signal handler to clean up runner directory on Ctrl+C. Add parent-PID liveness tracking to detect and kill orphaned Docker containers on startup. Wire up pruneStaleWorkspaces to clean up old run directories.
- cd24a04: Fix actions/checkout@v6 compatibility by using the real HEAD SHA instead of a fake placeholder.
- e42f4a9: Fix Docker socket detection on Linux when /var/run/docker.sock exists but is not accessible (EACCES).
- 02741dc: Mount warm node_modules directly at workspace path instead of symlinking via /tmp
- Updated dependencies [f7e42f0]
- Updated dependencies [cd24a04]
- Updated dependencies [e42f4a9]
- Updated dependencies [02741dc]
  - dtu-github-actions@0.8.2

## 0.8.1

### Patch Changes

- 1f24fec: Make GitHub authentication opt-in for remote reusable workflow fetching. Add --github-token CLI flag and AGENT_CI_GITHUB_TOKEN env var.
- Updated dependencies [1f24fec]
  - dtu-github-actions@0.8.1

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
- Updated dependencies [f660c11]
- Updated dependencies [ba84b69]
- Updated dependencies [c7d45a2]
- Updated dependencies [7a612b0]
- Updated dependencies [fbd8dea]
- Updated dependencies [8fbe36d]
- Updated dependencies [81aedf3]
- Updated dependencies [912ed83]
- Updated dependencies [2820b5a]
- Updated dependencies [1b1c664]
- Updated dependencies [6b7a95b]
- Updated dependencies [cf31ce1]
- Updated dependencies [ed4e86c]
- Updated dependencies [e9c5df5]
- Updated dependencies [789e403]
  - dtu-github-actions@0.8.0

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
- Updated dependencies [17ef340]
- Updated dependencies [336fb98]
- Updated dependencies [cc73a1f]
- Updated dependencies [be5cacd]
- Updated dependencies [5fadfee]
- Updated dependencies [1e9d7ca]
- Updated dependencies [73f6bf0]
  - dtu-github-actions@0.7.1

## 0.7.0

### Minor Changes

- c2fe31b: Cache action tarballs on first download and serve from disk on subsequent runs, eliminating ~30s GitHub CDN delays. Capture step output via tee to signals dir for reliable pause-on-failure tail display. Fix CLI to treat empty results as failure.
- acb750f: Show Docker image pull progress (bytes downloaded / total) as a sub-step under "Starting runner" during boot.

### Patch Changes

- f9f17fd: Detect project package manager and only mount relevant PM cache directories into the container. Projects using npm, yarn, or bun no longer get unnecessary pnpm store bind mounts (and vice versa). Falls back to mounting all PM caches when no lockfile is detected.
- Updated dependencies [f9f17fd]
- Updated dependencies [c2fe31b]
- Updated dependencies [acb750f]
  - dtu-github-actions@0.7.0

## 0.6.0

### Minor Changes

- 6e53753: Post GitHub commit status via gh CLI after agent-ci run completes

### Patch Changes

- d273b76: Show full per-step log content in failure summary instead of a truncated 20-line tail.
- a987818: Simplify Docker host resolution to be OS-agnostic by default, with explicit environment-variable overrides for custom networking setups.
- Updated dependencies [6e53753]
- Updated dependencies [d273b76]
- Updated dependencies [a987818]
  - dtu-github-actions@0.6.0

## 0.5.0

### Minor Changes

- 179405b: Add package metadata, SKILL.md, and AI agent discoverability section to README

### Patch Changes

- Updated dependencies [179405b]
  - dtu-github-actions@0.5.0

## 0.4.0

### Minor Changes

- 61d3e25: Add --no-matrix flag to collapse matrix workflows into a single job.

### Patch Changes

- Updated dependencies [61d3e25]
  - dtu-github-actions@0.4.0

## 0.3.4

### Patch Changes

- 6ada721: Fix Node 22 crash caused by `@actions/workflow-parser` importing JSON without the required `type: "json"` import attribute. A custom ESM loader hook now transparently adds the missing attribute at runtime. Fixes #67.
  - dtu-github-actions@0.3.4

## 0.3.3

### Patch Changes

- fix(dtu): replace execa with node:child_process to fix production runtime error
- Updated dependencies
  - dtu-github-actions@0.3.3

## 0.3.2

### Patch Changes

- 0d5a027: Fix rejected promise handling in job execution and refactor error handling to use type guards with `taskName` attached to errors.
- Fix `npx @redwoodjs/agent-ci` failing with "import: command not found" by adding the missing `#!/usr/bin/env node` shebang to the CLI entry point.
  - dtu-github-actions@0.3.2

## 0.3.1

### Patch Changes

- 6e0ace7: Fix rejected promise handling in job execution and refactor error handling to use type guards with `taskName` attached to errors.
  - dtu-github-actions@0.3.1

## 0.3.0

### Minor Changes

- 8510ce1: Add workflow compatibility features: cross-job outputs, job-level `if` conditions, `fromJSON()`/`toJSON()`, and `strategy.fail-fast` support.

### Patch Changes

- Updated dependencies [9b34858]
  - dtu-github-actions@0.3.0

## 0.2.0

### Minor Changes

- 7bce818: Initial release.

### Patch Changes

- e074b4c: Updated documentation.
- Updated dependencies [7bce818]
  - dtu-github-actions@0.2.0
