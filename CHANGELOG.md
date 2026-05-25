# Changelog

## Unreleased

- Hardened opt-in Rust orchestration so matrix legs are keyed by schedule key, matrix `needs` results are aggregated, worker failures preserve sibling outcomes, DTU cleanup/security is enforced, cyclic dependencies error during planning, pull request branch filters use the actual branch, detached pause handling is covered directly, and the Rust smoke parity gate exercises docker buildx directly without nesting agent-ci inside agent-ci.
