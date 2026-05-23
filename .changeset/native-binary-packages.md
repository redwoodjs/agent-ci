---
"@redwoodjs/agent-ci": minor
"@redwoodjs/agent-ci-darwin-arm64": minor
"@redwoodjs/agent-ci-darwin-x64": minor
"@redwoodjs/agent-ci-linux-arm64": minor
"@redwoodjs/agent-ci-linux-x64": minor
"dtu-github-actions": minor
---

Add the native Rust Agent CI binary, platform-specific npm packages, and an opt-in launcher path while keeping the TypeScript fallback available. The native help omits the unsupported `--jobs` override until concurrency is wired in the Rust runner, and the Rust implementation is split into focused run, DTU, Docker, runner, and macOS VM modules.
