# Agent CI — Claude Code Instructions

## Rules

- [Changeset Required](.claude/rules/changeset-required.md) — Every PR must include a changeset and update the root CHANGELOG.md

# Machinen — Agent Rules

## Testing

Before completing any work, you MUST run and pass:

`npx agent-ci run --all --quiet --pause-on-failure`

If it fails, fix the issue and re-run. Do not tell the user work is done until it passes.

## CI

- Always use `--quiet` (`-q`) when running agent-ci.
- Run `/validate` to check all workflows: `npx agent-ci run --all -q -p`

## Code

- This is a Node.js ESM project (`.mjs` files). Use `import`, not `require`.
- Package manager is pnpm (pinned via `packageManager` in package.json).
- Docker operations go through `src/docker.mjs`. Cloud operations through `src/cloud.mjs`.
- The user authenticates via OAuth (`gh auth login`), never API keys.
