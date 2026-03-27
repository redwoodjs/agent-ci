# dtu-github-actions

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
