---
"@redwoodjs/agent-ci": minor
---

Add the Rust Agent CI runner implementation for source-checkout parity testing while keeping the published npm package on the TypeScript runner path. From a repository checkout, `AGENT_CI_FORCE_RUST=1 pnpm agent-ci-dev ...` builds and runs the Rust binary; published npm installs do not include a native runner yet. The Rust runner now honors `--jobs` for concurrent dependency-wave execution, macOS VM execution honors `AGENT_CI_MACOS_VM_CONCURRENCY`, nested local runs avoid container-name collisions, smoke benchmarks compare TypeScript and Rust orchestration overhead, shared TypeScript/Rust fixture contracts cover scheduler, event, run-result, Docker socket, and default job-limit parity, pure workflow planning plus reusable workflow expansion and event/result contracts now live in `agent-ci-core`, the generic job-wave pool and execution-plan adapters live in `agent-ci-runtime`, `--all` has Rust smoke coverage and workflow fan-out, and the Rust implementation is split into core and runtime crates with focused run, DTU, expression, Docker, runner, and macOS VM modules.

Native npm platform-package publishing and npm-launcher native opt-in are intentionally deferred until the release workflow builds, stages, and verifies real target binaries in the same artifact-staging style used by `redwoodjs/machinen`.
