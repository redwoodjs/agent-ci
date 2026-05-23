---
"@redwoodjs/agent-ci": minor
"@redwoodjs/agent-ci-darwin-arm64": minor
"@redwoodjs/agent-ci-darwin-x64": minor
"@redwoodjs/agent-ci-linux-arm64": minor
"@redwoodjs/agent-ci-linux-x64": minor
"dtu-github-actions": minor
---

Add the native Rust Agent CI binary, platform-specific npm packages, and an opt-in launcher path while keeping the TypeScript fallback available. The native runner now honors `--jobs` for concurrent dependency-wave execution, macOS VM execution honors `AGENT_CI_MACOS_VM_CONCURRENCY`, nested local runs avoid container-name collisions, and the Rust implementation is split into focused run, DTU, expression, Docker, runner, and macOS VM modules.
