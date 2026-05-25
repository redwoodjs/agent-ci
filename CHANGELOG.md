# Changelog

## Unreleased

- Hardened opt-in Rust orchestration so matrix legs are keyed by schedule key, matrix `needs` results are aggregated, reusable workflows and workflow-call outputs are expanded, worker failures preserve sibling outcomes, DTU cleanup/security is enforced, cyclic dependencies error during planning, pull request branch filters use the actual branch, detached pause handling is covered directly, and the Rust smoke parity gate exercises the expanded smoke suite with retries and per-workflow timeouts.
