# @redwoodjs/agent-ci

## 0.3.2

### Patch Changes

- 0d5a027: Fix rejected promise handling in job execution and refactor error handling to use type guards with `taskName` attached to errors.
<<<<<<< changeset-release/main
=======
- Fix `npx @redwoodjs/agent-ci` failing with "import: command not found" by adding the missing `#!/usr/bin/env node` shebang to the CLI entry point.
>>>>>>> main
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
