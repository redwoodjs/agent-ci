# Agent CI — Claude Code Instructions

## Rules

- [Changeset Required](.claude/rules/changeset-required.md) — Every PR must include a changeset and update the root CHANGELOG.md

## CI

Before completing any work, run `/validate` to check all workflows. If it fails, fix the issue and re-run. Do not tell the user work is done until it passes.

## Code

- This is a Node.js ESM project (`.mjs` files). Use `import`, not `require`.
- Package manager is pnpm (pinned via `packageManager` in package.json).
- Docker operations go through `src/docker.mjs`. Cloud operations through `src/cloud.mjs`.
- The user authenticates via OAuth (`gh auth login`), never API keys.
