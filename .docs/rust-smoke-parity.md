# Rust smoke workflow parity

This file tracks smoke workflow coverage for the native Rust rewrite.

## Current smoke set

`pnpm rust:smoke:parity` builds the Rust binary and executes these existing workflows end-to-end with `--jobs 2` to exercise native wave concurrency:

- `.github/workflows/smoke-binary.yml`
- `.github/workflows/smoke-expressions.yml`
- `.github/workflows/smoke-matrix.yml`
- `.github/workflows/smoke-artifacts.yml`
- `.github/workflows/smoke-docker-buildx.yml`
- `.github/workflows/smoke-pause-pipe.yml`
- a generated two-workflow `--all` repo smoke that exercises Rust all-workflow discovery and workflow fan-out

The default expectation is now successful Rust execution for every workflow in the smoke set. The old discovery-only gap is no longer accepted by this gate.

## Current status

- Rust `run` wires the DTU + Docker execution path for these core smoke workflows.
- Rust `run --all` fans out relevant workflows with a global workflow/job cap instead of running every workflow serially.
- The smoke parity script fails on any non-zero workflow result or if Rust reports the old “execution is not implemented” gap.
- Keep expanding this list as the remaining parity gates move from targeted tests to default coverage.
