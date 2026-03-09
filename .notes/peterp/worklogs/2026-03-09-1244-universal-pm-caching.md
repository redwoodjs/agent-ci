---
title: Universal Package Manager Caching
date: 2026-03-09 12:44
author: peterp
---

# Universal Package Manager Caching

## Summary

Generalized Machinen's PNPM-specific install caching to support NPM, Yarn, and Bun. Lockfile detection, sentinel checks, cache bind-mounts, and virtual cache patterns all extended. 34 tests pass.

## The Problem

Machinen's warm `node_modules` caching was hardcoded to PNPM: lockfile hash only checked `pnpm-lock.yaml`, integrity sentinel only checked `.modules.yaml`, and only the PNPM store was bind-mounted.

Benchmark results (from prior session) showed the symlink strategy works universally — 40s→0s for NPM, 3s→0s for Yarn, 14s→0s for Bun.

## Investigation & Timeline

- **Initial State:** Reviewed `cleanup.ts`, `directory-setup.ts`, `container-config.ts`, `local-job.ts` — all PNPM-specific.
- **Attempts:**
  - Extended `computeLockfileHash()` to search `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock`, `bun.lockb`
  - Created `hasInstallSentinel()` that checks `.modules.yaml` (pnpm), `.package-lock.json` (npm), `.yarn-integrity` (yarn), `.cache/` (bun)
  - Added `npmCacheDir` and `bunCacheDir` to `RunDirectories` and `ContainerBindsOpts`
  - Extended `virtualCachePatterns` from `["pnpm"]` to `["pnpm", "npm", "yarn", "bun"]`
  - Updated all test fixtures to include new fields

## Discovery & Key Findings

- NPM writes `.package-lock.json` inside `node_modules/` after successful install
- Yarn Classic writes `.yarn-integrity` inside `node_modules/`
- Bun doesn't write a top-level sentinel but reliably creates `.cache/`
- NPM's global cache at `~/.npm` gives 20× speedup when warm (40s→2s)

## Resolution

Files changed:

- `cli/src/output/cleanup.ts` — universal lockfile and sentinel detection
- `cli/src/runner/directory-setup.ts` — npm-cache and bun-cache dirs
- `cli/src/docker/container-config.ts` — new bind mounts
- `cli/src/runner/local-job.ts` — extended virtual cache patterns
- `cli/src/output/cleanup.test.ts` — 10 new tests
- `cli/src/docker/container-config.test.ts` — updated fixtures

## Next Steps

- [ ] Test with a real NPM-based project (e.g. `create-next-app`) in a full workflow run
- [ ] Verify Bun sentinel detection with a real Bun install
- [ ] Fix box-drawing alignment in bench.sh
