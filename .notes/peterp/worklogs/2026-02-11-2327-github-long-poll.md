---
title: GitHub Long-Poll Implementation
date: 2026-02-11 23:27
author: peterp
---

# GitHub Long-Poll Implementation

## Summary

Implemented the "GitHub Long-Poll" feature in the Agent CI runner to ensure that self-hosted jobs are correctly picked up by the official GitHub Actions runner. This involved updating documentation, adding automatic discovery of the official runner (`run.sh`), and updating the recommended label to `agent-ci`.

## The Problem

GitHub Actions require an active HTTPS long-poll connection from a registered runner to send jobs with `runs-on: self-hosted`. If only the Agent CI agent is polling the bridge, GitHub considers the runner "offline" for self-hosted jobs, causing them to hang in the "Queued" status.

## Investigation & Timeline

- **Initial State:** The runner was polling the Agent CI bridge for jobs and spawning Docker containers. However, it didn't manage the official GitHub Actions runner.
- **Attempts:**
  - Initially planned to use an environment variable `GITHUB_RUNNER_PATH`.
  - Researched GitHub REST API for automated registration (JIT config).
  - Decided to simplify to a convention-based discovery looking for `actions-runner/run.sh`.
  - Updated `test.yml` and docs to use `agent-ci` label instead of `self-hosted`.

## Discovery & Key Findings

- GitHub's `self-hosted` label is the default, but using a custom label like `agent-ci` helps differentiate Agent CI nodes and avoids conflicts with other self-hosted runners.
- The official runner must be running its own `./run.sh` to maintain the long-poll connection that GitHub expects.

## Resolution

- Implemented `startGitHubRunner()` in `executor.ts` using Node `spawn` with `stdio: "inherit"`.
- Added `findRunnerPath()` to automatically discover `run.sh` in `./actions-runner` or `../actions-runner`.
- Updated documentation (`github-actions.md`, `release.md`) and workflows (`test.yml`).

## Next Steps

- [ ] Automate runner registration via GitHub REST API (JIT tokens)
- [ ] Implement automatic downloading of the official runner binary
