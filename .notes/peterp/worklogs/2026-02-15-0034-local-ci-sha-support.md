---
title: Support for oa run <sha>
date: 2026-02-15 00:34
author: peterp
---

# Support for oa run <sha>

## Summary
Implemented the ability to run local CI simulations against specific historical commits by passing a SHA to the `oa run` command.

## The Problem
Previously, `oa run` only operated on the current `HEAD`. To test historical commits or specific branches locally without checking them out first, developers needed a way to specify a SHA.

## Investigation & Timeline
* **Initial State:** `oa run` was hardcoded to use `git rev-parse HEAD`.
* **Attempts:**
    * Modified `runner/src/cli.ts` to capture `process.argv[3]`.
    * Added validation using `git rev-parse --verify <sha>` to ensure the provided string is a valid git object.
    * Updated the Bridge API payload to include the validated `headSha`.
    * Injected `OA_HEAD_SHA` into the Docker container environment in `WarmPool.ts`.
    * **Verification:** Tested with:
        * `pnpm oa run` (defaults to HEAD).
        * `pnpm oa run <valid-sha>` (uses SHA).
        * `pnpm oa run <invalid-sha>` (throws error).

## Discovery & Key Findings
* Pre-validating the SHA in the CLI provides immediate feedback to the developer before any network requests or container spawning occurs.
* Injected environment variables (`OA_HEAD_SHA`) allow the runner to report status accurately even when the container's internal git state might be shimmed or modified.

## Resolution
The `oa run` command now supports an optional `[sha]` argument. The runner infrastructure is now SHA-aware for local sync jobs.

## Next Steps
- [ ] Implement UI indicators in the Bridge/Console to show which SHA a local run is targeting.
- [ ] Add support for running against short-SHAs or branch names (currently relies on `git rev-parse` which handles most, but explicit branch mapping could be clearer).
