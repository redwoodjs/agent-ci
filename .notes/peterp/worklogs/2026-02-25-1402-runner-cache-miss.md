---
title: Fix Node.js Cache Miss on Self-Hosted Runner
date: 2026-02-25 14:02
author: peterp
---

# Fix Node.js Cache Miss on Self-Hosted Runner

## Summary

Investigated why `actions/setup-node` was downloading the Node.js binaries on every test run instead of utilizing the cache on the `agent-ci` self-hosted runner. Fixed the issue by creating and mounting a persistent `toolcache` directory to `/opt/hostedtoolcache` on the ephemeral runner containers.

## The Problem

When running `.github/workflows/tests.yml` locally via the `agent-ci` self-hosted runner, the runner failed to find Node.js in the cache, forcing a multi-second internet download on every single run.

## Investigation & Timeline

- **Initial State:** The oldest test run unexpectedly hit the cache. We noticed it ran on `ubuntu-latest` because the CF worker failed to find the local agent presence. The `ubuntu-latest` image inherently has `/opt/hostedtoolcache` prepopulated.
- **Attempts:**
  - We read the logs of both the oldest run and a recent self-hosted run.
  - We realized the `setup-node` step tries to locate cached tools specifically in `/opt/hostedtoolcache`.
  - We reviewed `supervisor/src/local-job.ts` to see how our ephemeral runner containers were created and confirmed there was no persistent directory mapped to `/opt/hostedtoolcache`.

## Discovery & Key Findings

Unlike GitHub's official runners which bake tens of gigabytes of tools into the host image, ephemeral Docker containers simply don't have this. Thus, our self-hosted runner downloads the tool and saves it inside the ephemeral container's `/opt/hostedtoolcache`. But because the container is destroyed at the end of the run, the cache is wiped with it.

## Resolution

```typescript
// supervisor/src/local-job.ts
const toolCacheDir = path.resolve(workDir, "toolcache");
fs.mkdirSync(toolCacheDir, { recursive: true, mode: 0o777 });

// ... inside docker config:
Env: [
  // ...
  `RUNNER_TOOL_CACHE=/opt/hostedtoolcache`,
],
HostConfig: {
  Binds: [
    // ...
    `${toolCacheDir}:/opt/hostedtoolcache`,
  ]
}
```

We mounted a persistent host folder (`toolcache` in the `_` working directory) into the ephemeral container as `/opt/hostedtoolcache`. Now, tools downloaded during one run are persisted and available to all future runs. We also added a documentation note to `README.md` to explain this behavior.

## Next Steps

- [ ] Confirm the tests hit the toolcache gracefully on the next run.
