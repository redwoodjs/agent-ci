---
title: Package Manager Cache Benchmarking
date: 2026-03-09 10:01
author: peterp
---

# Package Manager Cache Benchmarking

## Summary

Investigated whether the PNPM warm `node_modules` caching strategy can be generalized to NPM, Yarn, and Bun. Created benchmark scripts and ran experiments using a real `create-rwsdk` project. Result: the symlink strategy is universally instant — cold installs of 3–40s → 0.0s for all package managers.

## The Problem

Agent CI has three PNPM-specific caching layers (warm `node_modules` keyed by lockfile hash, shared pnpm-store bind-mount, wave serialization). None of this exists for NPM or Yarn. We needed data to decide whether it's worth generalizing.

## Investigation & Timeline

- **Initial State:** Analyzed existing caching code across `cleanup.ts`, `directory-setup.ts`, `container-config.ts`, `local-job.ts`, and `store.ts`. All lockfile detection, sentinel checks, and store mounts are PNPM-only.
- **Attempts:**
  - Scaffolded a real `create-rwsdk` project (12 deps including React 19, Vite 7, Wrangler)
  - Wrote `bench.sh` to test 4 scenarios: cold install, warm global cache, warm node_modules, symlink-only
  - First run failed due to `set -euo pipefail` + lockfile copy errors — fixed by switching to `set -uo pipefail` and python3 for ms-precision timing
  - Yarn failed because monorepo's `packageManager` field blocked non-pnpm tools — fixed by stripping `pnpm`/`packageManager` fields from `package.json` and running `yarn --version` from `/tmp`
  - Yarn Berry v3 uses different CLI flags than Yarn Classic — updated to use `--immutable`, `.yarnrc.yml` config, and `cd` instead of `--cwd`

## Discovery & Key Findings

| Scenario          | NPM 10.9 | Yarn 3.3 | Bun 1.3  |
| ----------------- | -------- | -------- | -------- |
| Cold install      | 40.1s    | 3.1s     | 13.9s    |
| Warm global cache | 2.0s     | 3.1s     | 1.1s     |
| Warm node_modules | 17.1s    | 0.4s     | 0.1s     |
| **Symlink**       | **0.0s** | **0.0s** | **0.0s** |

- Symlink warm `node_modules` is instant for every PM — the strategy is universal
- NPM benefits most (40s → 0s); its global cache warm also gives a 20× speedup
- Bun's global cache is very effective (13.9s → 1.1s)
- Yarn Berry is already fast even cold (3.1s)

## Resolution

Created `experiments/pkg-cache-bench/` with:

- `bench.sh` — automated benchmark script for NPM, Yarn Berry, and Bun
- `package.json` — real `create-rwsdk` project dependencies
- `README.md` — usage docs

## Next Steps

- [ ] Generalize `computeLockfileHash()` to detect `package-lock.json`, `yarn.lock`, `bun.lock`
- [ ] Replace `.modules.yaml` sentinel with PM-appropriate files (`.package-lock.json` for NPM, `.yarn-integrity` for Yarn)
- [ ] Optionally bind-mount each PM's global cache dir for the warm-cache speedup
- [ ] Update `virtualCachePatterns` to include `"npm"`, `"yarn"`, `"bun"` if stores are mounted
