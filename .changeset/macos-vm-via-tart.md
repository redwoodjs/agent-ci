---
"@redwoodjs/agent-ci": minor
"dtu-github-actions": minor
---

Run `runs-on: macos-*` jobs in a real macOS VM via [tart](https://github.com/cirruslabs/tart) on Apple Silicon hosts.

When the host is `darwin`/`arm64` with `tart` and `sshpass` installed, jobs whose `runs-on:` targets macOS launch a cirruslabs macOS VM, rsync in the macOS `actions-runner` binary, and connect the runner to the ephemeral DTU via the host bridge. Concurrency is capped at 2 VMs by default (override with `AGENT_CI_MACOS_VM_CONCURRENCY`).

Hosts that don't support this (Linux, Intel macOS, missing tart/sshpass) continue to skip macOS jobs with the same warning introduced in #273. Windows jobs are still skipped on all hosts.

Image mapping:

- `macos-13` → `macos-ventura-xcode:latest`
- `macos-14` → `macos-sonoma-xcode:latest`
- `macos-15` → `macos-sequoia-xcode:latest`
- `macos-26` → `macos-tahoe-xcode:latest`
- `macos` / `macos-latest` → `macos-sonoma-xcode:latest`
- Override with `AGENT_CI_MACOS_VM_IMAGE`.
