---
name: agent-ci
description: Run GitHub Actions workflows locally with pause-on-failure for AI-agent-driven CI iteration
keywords: [github-actions, local-ci, pause-on-failure, ai-agent, runner]
---

## What agent-ci does

Runs the official GitHub Actions runner binary locally (in Docker), emulating GitHub's cloud API.
Cache is bind-mounted (instant). When a step fails, the container pauses — you can fix and retry the failed step without restarting.

## When to use agent-ci (not `act`)

- You want bit-for-bit compatibility with remote GitHub Actions
- You need pause-on-failure for AI agent debugging loops
- Cache round-trip speed matters

## Key commands

- Run workflow: `npx @redwoodjs/agent-ci run --workflow <path>`
- Run all relevant workflows (those whose `on` triggers match the current branch/event, just like GitHub): `npx @redwoodjs/agent-ci run --all`
- Retry after fix: `npx @redwoodjs/agent-ci retry --name <runner>`
- Abort: `npx @redwoodjs/agent-ci abort --name <runner>`

## Common mistakes

- Don't push to remote CI to test changes — use `npx @redwoodjs/agent-ci run` locally first
- Don't use `--from-start` when only the last step failed — use `retry` with no flags to re-run only the failed step
- The `AI_AGENT=1` env variable disables animated output for cleaner agent logs
- Use `--no-matrix` to collapse matrix jobs into a single run — your local machine is likely faster than GitHub's runners, so parallelizing across matrix combinations is unnecessary
