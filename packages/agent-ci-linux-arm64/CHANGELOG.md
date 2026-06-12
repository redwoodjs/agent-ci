# @redwoodjs/agent-ci-linux-arm64

## 0.17.0

### Minor Changes

- 7a349fd: Add the native Rust Agent CI binary, platform-specific npm packages, and an opt-in launcher path while keeping the TypeScript fallback available. The native runner now honors `--jobs` for concurrent dependency-wave execution, macOS VM execution honors `AGENT_CI_MACOS_VM_CONCURRENCY`, nested local runs avoid container-name collisions, a smoke benchmark suite compares TypeScript and Rust orchestration overhead, shared TypeScript/Rust fixture contracts cover scheduler, event, run-result, Docker socket, and default job-limit parity, pure workflow planning plus reusable workflow expansion and event/result contracts now live in `agent-ci-core`, the generic job-wave pool and execution-plan adapters live in `agent-ci-runtime`, platform packages stage `bin/agent-ci`, `--all` now has Rust smoke coverage and workflow fan-out, and the Rust implementation is split into core and runtime crates with focused run, DTU, expression, Docker, runner, and macOS VM modules.
