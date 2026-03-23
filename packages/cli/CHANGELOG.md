# @redwoodjs/agent-ci

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
