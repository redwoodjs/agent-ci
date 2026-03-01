---
title: Fixing E2E Tests in Docker-in-Docker CI
date: 2026-02-23 21:32
author: peterp
---

# Fixing E2E Tests in Docker-in-Docker CI

## Summary

We investigated and resolved a series of cascading failures that prevented the E2E tests from passing when the `oa-1` project was run inside a generic GitHub Actions CI runner (`ubuntu-latest` running the `ghcr.io/actions/actions-runner:latest` container). The final outcome is a completely green CI pipeline, with both unit tests (24/24) and E2E tests passing within the nested container environment.

## The Problem

The core issue began with `pnpm: command not found` inside the CI runner. Fixing that revealed a chain of subsequent issues related to running Docker-in-Docker (DinD)—specifically, nested containers failing to prepare their workspaces, failing to communicate with the host API, and suffering from restrictive directory permissions, all culminating in the nested runner crashing with `Exit 1`.

## Investigation & Timeline

- **Initial State:** The CI workflow `.github/workflows/tests.yml` failed immediately on the `pnpm install` step.
- **Attempts:**
  - **Missing Node.js PATH:** Discovered the Actions runner bundles Node.js but doesn't add it to the `$PATH`. Fixed by appending `/home/runner/externals/node20/bin` to the `$PATH` in `localJob.ts` and `warm-pool.ts`.
  - **Docker Socket Permissions:** The nested container crashed with `connect EACCES /var/run/docker.sock`. Fixed by adding `sudo chmod 666 /var/run/docker.sock` to the container's `Cmd` startup script.
  - **Recursive Docker Execution:** The E2E tests executed the main `tests.yml` workflow, causing an infinite loop of nested Docker containers. Fixed by switching the E2E setup to use a simpler `smoke-tests.yml`.
  - **Unit Test Flakiness:** The `dtu-github-actions` tests were failing due to a race condition on `404.log`. Fixed by making `DTU_LOGS_DIR` configurable and setting `fileParallelism: false` in Vitest.
  - **DinD Networking failure:** Nested runners couldn't reach the DTU via `host.docker.internal` (points to the Mac host, not the CI container).
    - _Attempt:_ Used `ip route get 1`. _Failed:_ Command not available in runner image.
    - _Resolution:_ Switched to `hostname -I | awk '{print $1}'` to fetch the CI container's bridge IP dynamically.
  - **Workspace Preparation Failure:** `rsync` was missing from the Actions runner image, causing `localJob` workspace preparation to fail.
    - _Resolution:_ Implemented a Node.js `fs.cpSync` fallback that individually copies files governed by `git ls-files`.
  - **Bind-Mount Permissions:** Even with the code copied, the nested runner crashed with `mkdir: Permission denied` and `UnauthorizedAccessException: Access to the path '/home/runner/_diag/...log' is denied`.
    - _Cause:_ The outer supervisor process ran as root inside the CI container, creating `_work` and `_diag` bind mounts as root. The nested container (running as `runner` UID 1001) lacked write access.
    - _Resolution:_ Pre-created directories with `mode: 0o777` in `localJob.ts` and added `sudo chmod -R 777 /home/runner/_work /home/runner/_diag` to the Cmd script.

## Discovery & Key Findings

1. **GitHub Actions Runner Quirks:** The `actions-runner:latest` image is highly stripped down. Relying on host-level tools like `rsync` or `ip` utilities is unsafe; Node.js fallbacks are much more reliable.
2. **DinD Networking:** `host.docker.internal` behaves differently in native nested contexts vs. Docker Desktop for Mac. Inside a Linux CI container, the bridge IP of the container itself must be used for nested reverse-proxy routing.
3. **Bind-mount Permissions in DinD:** Docker automatically creates host path directories as `root` if they don't exist prior to mounting. Since the CI environment itself ran as root, these restrictive permissions propagated down to the nested runner user.

## Resolution

The final set of fixes deployed across the codebase:

1. Configured custom `vitest.config.ts` for sequential test running in DTU.
2. Modified the `localJob.ts` container schema implementation:
   - Added Node.js to `$PATH`.
   - Used `hostname -I` to fetch the correct `OA_DTU_HOST` proxy target.
   - Replaced `rsync` with a robust `fs.cpSync` fallback.
   - Pre-created bind-mounted directories with 0o777 permissions and issued a recursive `chmod` in the container startup script.
3. Cleaned up all tracking debug code and verbose logging in the GitHub workflow and E2E tests wrapper.

## Next Steps

- [ ] Investigate refactoring the nested runner initialization script (`config.sh` wrapper) into a discrete initialization file rather than a massive inline bash string.
- [ ] Review the `executeLocalJob` CLI command path to ensure the CLI exits with a non-zero status code when a local job yields a failure exit code.
