---
name: "agent-ci"
description: "Use when running GitHub Actions locally, especially when you want pause-on-failure, fix-in-place retries, or a faster agent-friendly loop than pushing to remote CI."
---

# Agent CI

Use this skill when a repo has GitHub Actions workflows and you want to run them locally, keep failures alive for debugging, and retry only the broken part.

## What this plugin is for

- Run the same workflow logic locally instead of pushing just to see CI fail.
- Pause on failure so the workspace and container state stay available while you fix the issue.
- Retry only the failed step after a fix.

## Prerequisites

- Node.js 22 or newer
- Docker running locally, or `DOCKER_HOST` pointing at a reachable daemon
- A repo with `.github/workflows/*.yml` or `.yaml`

## Quick start

1. Check which workflows exist:
   - `rg --files .github/workflows`
2. Run one workflow through the bundled wrapper:
   - `bash node_modules/@redwoodjs/agent-ci/codex-plugin/skills/agent-ci/scripts/agent-ci.sh run --workflow .github/workflows/ci.yml --quiet`
3. Or run the workflows relevant to the current branch:
   - `bash node_modules/@redwoodjs/agent-ci/codex-plugin/skills/agent-ci/scripts/agent-ci.sh run --all --quiet --no-matrix`

## Failure loop

1. Start with `--quiet` so logs stay readable for agent work.
2. If a step fails, note the runner name in the output.
3. Fix the issue in the repo.
4. Retry only the failed step:
   - `bash node_modules/@redwoodjs/agent-ci/codex-plugin/skills/agent-ci/scripts/agent-ci.sh retry --name <runner-name>`
5. If you need to stop and clean up:
   - `bash node_modules/@redwoodjs/agent-ci/codex-plugin/skills/agent-ci/scripts/agent-ci.sh abort --name <runner-name>`

## Working rules

- Prefer local Agent CI before pushing to trigger remote CI.
- Use `--no-matrix` for fast local confidence unless full matrix coverage is required.
- If Docker networking is custom or remote, set `DOCKER_HOST`, `AGENT_CI_DTU_HOST`, or related environment overrides before running.
- If the package is already installed in the repo, the wrapper uses it. Otherwise it falls back to `npx` automatically.

## Common commands

- Run a specific workflow:
  - `bash node_modules/@redwoodjs/agent-ci/codex-plugin/skills/agent-ci/scripts/agent-ci.sh run --workflow .github/workflows/ci.yml --quiet`
- Run all matching workflows:
  - `bash node_modules/@redwoodjs/agent-ci/codex-plugin/skills/agent-ci/scripts/agent-ci.sh run --all --quiet --no-matrix`
- Retry from the failed step:
  - `bash node_modules/@redwoodjs/agent-ci/codex-plugin/skills/agent-ci/scripts/agent-ci.sh retry --name <runner-name>`
- Retry from the start:
  - `bash node_modules/@redwoodjs/agent-ci/codex-plugin/skills/agent-ci/scripts/agent-ci.sh retry --name <runner-name> --from-start`
- Abort a paused run:
  - `bash node_modules/@redwoodjs/agent-ci/codex-plugin/skills/agent-ci/scripts/agent-ci.sh abort --name <runner-name>`
