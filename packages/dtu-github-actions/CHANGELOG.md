# dtu-github-actions

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
