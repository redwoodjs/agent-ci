---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Fix `--all` run hanging on single-job workflows (tests.yml etc).

Root cause: all ephemeral DTU instances share an in-process state singleton. Jobs seeded without a `runnerName` went into the shared generic pool and could be stolen by runners from other concurrent workflows. Fix: always pin `job.runnerName = containerName` before seeding so every job goes to the runner-specific pool.

Also fixes nested agent-ci runs in DinD environments: `tests.yml`'s "Test retry-proof failure output" step now skips when `AGENT_CI_LOCAL=true` (set via Docker env on all runner containers) since the inner DTU is unreachable from containers created via the shared host socket. The `AGENT_CI_LOCAL` env var is now set at the Docker container level (reliable shell visibility) and also propagated through the DTU's job-level env to Variables (so `${{ env.AGENT_CI_LOCAL }}` works in expressions).

Additional smoke-tests.yml fixes:

- `pnpm -r build` scoped to `./packages/**` only (excludes `apps/website` whose build fails in the runner environment)
- Added `chmod +x packages/cli/dist/cli.js` so `npx --yes ./packages/cli` can execute the binary
- `useDirectContainer` seed validation now checks for `run.sh` existence in addition to the `.seeded` marker to detect incomplete extractions
