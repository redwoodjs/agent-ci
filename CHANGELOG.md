# Changelog

## Unreleased

- Added runner package-manager install shims so parallel local Agent CI jobs serialize writes to the shared warm `node_modules` mount and, for non-workspace projects, reuse duplicate lockfile-keyed project installs instead of requiring repo-specific install lock scripts.
- Hardened opt-in Rust orchestration so matrix legs are keyed by schedule key, matrix `needs` results are aggregated, reusable workflows and workflow-call outputs are expanded, worker failures preserve sibling outcomes, DTU cleanup/security is enforced, cyclic dependencies error during planning, pull request branch filters use the actual branch, detached pause handling is covered directly, nested ephemeral DTU servers advertise the container IP to sibling runners, nested runner containers join the parent Docker network, Rust cleanup removes nested containers attached to per-job networks, and the Rust smoke parity gate exercises the expanded smoke suite with per-workflow timeouts, duration summaries, heartbeats, status ledgers, failure diagnostics, and timeout cleanup.
