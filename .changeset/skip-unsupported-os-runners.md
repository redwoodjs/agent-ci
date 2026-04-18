---
"@redwoodjs/agent-ci": minor
"dtu-github-actions": minor
---

Skip jobs with `runs-on: macos-*` or `windows-*` instead of silently running them in a Linux container

Previously, jobs targeting macOS or Windows runners were silently routed to the Linux runner container and failed at the first OS-specific step (e.g. `Setup Xcode`), producing a confusing error. They now skip with a visible `[Agent CI]` warning that points at the tracking issues for real support. Linux and `self-hosted`-without-OS-hint jobs are unaffected.

Tracking:

- https://github.com/redwoodjs/agent-ci/issues/254 (this guardrail)
- https://github.com/redwoodjs/agent-ci/issues/258 (real macOS runner support)
