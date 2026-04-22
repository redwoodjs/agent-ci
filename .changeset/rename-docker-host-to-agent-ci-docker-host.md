---
"@redwoodjs/agent-ci": minor
"dtu-github-actions": minor
---

Rename `DOCKER_HOST` to `AGENT_CI_DOCKER_HOST` and load `AGENT_CI_*` vars from `.env.agent-ci`.

**Breaking:** agent-ci no longer honours the standard `DOCKER_HOST` env var. If it is set in the shell, agent-ci exits immediately with an error asking you to rename it. Rename it in your shell (or move it to `.env.agent-ci`) as `AGENT_CI_DOCKER_HOST`. This avoids the long-standing collision where users wanted agent-ci to target one daemon (e.g. a Lima/OrbStack VM) while their shell's `docker` CLI targeted another.

**New:** `AGENT_CI_*`-prefixed keys in `.env.agent-ci` are now loaded into the CLI process environment at startup, so Docker/network configuration (e.g. `AGENT_CI_DOCKER_HOST`, `AGENT_CI_DTU_HOST`, `AGENT_CI_DOCKER_EXTRA_HOSTS`) no longer has to be exported in the shell. Shell env vars still take precedence over `.env.agent-ci`. Non-prefixed keys in the file remain workflow secrets (`${{ secrets.FOO }}`) as before.

Closes #308.
