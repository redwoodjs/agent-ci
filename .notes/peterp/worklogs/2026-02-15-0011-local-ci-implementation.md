---
title: Local CI Implementation with oa run
date: 2026-02-15 00:11
author: peterp
---

# Local CI Implementation with oa run

## Summary

Implemented a local CI simulation feature via a new `oa run` command. This allows developers to sync uncommitted local changes into a Docker runner, leveraging bind mounts while protecting local files using a git shim mechanism.

## The Problem

Developers needed a way to trigger local CI runs that include their current, uncommitted code changes. The existing system was designed primarily for GitHub-triggered events. The challenge was to safely sync local files into a Docker container without allowing the container's GitHub Action (e.g., `actions/checkout`) to modify the host's git state or erase local changes.

## Investigation & Timeline

- **Initial State:** Runner and Bridge were operational but only handled GitHub webhook events.
- **Attempts:**
  - Created `runner/src/cli.ts` to implement the `oa run` command.
  - Added a dedicated POST endpoint `/api/local-job` in the Bridge to queue local sync jobs.
  - Modified `WarmPool.ts` to detect `localSync` jobs and spawn dedicated containers with:
    - Bind mount of the local repo: `${localPath}:/home/runner/_work/${repo}/${repo}`.
    - A git shim in `/tmp/agent-ci-shims` to intercept `checkout`, `fetch`, and `reset`.
  - **Obstacle:** Container failed to start because `PATH` was set to `$PATH`, inheriting the host's `PATH` which lacked container-specific binaries. Fix: Set a standard container `PATH` with shims prepended.
  - **Obstacle:** Bridge failed to process jobs because it tried to generate GitHub installation tokens for local jobs. Fix: Added a bypass for `localSync` jobs.
  - **Refinement:** Replaced the binary `"oa"` with a `package.json` script `"oa": "node --env-file=.env dist/cli.js"` to simplify environment management.

## Discovery & Key Findings

- **Git Shim Protection:** We learned that prepending a dummy `git` script to the `PATH` is a reliable way to intercept `actions/checkout` when using bind mounts.
- **Env File Loading:** Using `node --env-file=.env` is significantly cleaner for local CLI tools than manual configuration loading within the source code.

## Resolution

The system now supports `pnpm oa run` within the `runner` directory. This command queues a job that the local runner picks up, mounts the local directory, and executes the action against the current state of the filesystem.

## Next Steps

- [ ] Integrate GitHub Checks API for local run status reporting ("Self-Reporting").
- [ ] Implement `oa run <sha>` to allow running against specific historical commits.
- [ ] Refine the UI on the Bridge to distinguish between local and cloud runs.
