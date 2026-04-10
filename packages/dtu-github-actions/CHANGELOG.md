# dtu-github-actions

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
