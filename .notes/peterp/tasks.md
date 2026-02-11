## Next Steps
- [x] Implement Webhook Handler in `oa-1-bridge`
      Motivation: The Bridge needs to receive payloads from GitHub to queue jobs.
      Things to consider: GitHub signature verification, webhook payload structure.
      Importance: 5
      Cite references: [oa-1-bridge](../../oa-1-bridge)
- [x] Set up polling logic in `oa-1-runner`
      Motivation: The Runner needs to fetch jobs from the Bridge.
      Things to consider: Polling interval, authentication between Runner and Bridge.
      Importance: 5
      Cite references: [oa-1-runner](../../oa-1-runner)
- [x] Configure Docker environment for execution
      Motivation: Jobs must run in a containerized environment to ensure consistency and isolation.
      Things to consider: Volume mapping, persistent containers on failure.
      Importance: 4
- [x] Implement Docker Execution Logic in `oa-1-runner`
      Motivation: Real execution is needed to replace the current stub.
      Things to consider: Use `dockerode` or CLI, handle stdout/stderr, volume mounts.
      Importance: 5
      Cite references: [executor.ts](../../oa-1-runner/src/executor.ts)
- [x] Implement Persistence for Failed Jobs
      Motivation: Failed jobs must be preserved for debugging (keep container hot) and reported.
      Things to consider: Error reporting to Bridge, local logging.
      Importance: 4
- [x] Fetch Job Spec and Secrets directly in Docker
      Motivation: Mirror the official GitHub runner's pull-based architecture where the worker retrieves its own "Plan" and encrypted secrets.
      Things to consider: The container script needs access to the Bridge to pull its specific job details.
      Importance: 5
      Cite references: [docs/github-actions.md](../../docs/github-actions.md)
- [ ] Implement "Plan" parsing inside the container
      Motivation: The worker container now fetches raw JSON from GitHub and needs to parse it into executable steps.
      Things to consider: Handling the GitHub API response structure, mapping steps to shell commands.
      Importance: 5
      Cite references: [worklog: 2026-02-10-0853](worklogs/2026-02-10-0853-direct-github-pull.md)
- [x] Securely generate on-demand Installation Tokens in the Bridge
      Motivation: Moving away from a persistent `GITHUB_TOKEN` to short-lived, job-scoped installation tokens for better security.
      Things to consider: GitHub App authentication flow, token scope and expiration.
      Importance: 4
      Cite references: [worklog: 2026-02-11-1535](worklogs/2026-02-11-1535-github-installation-tokens.md)
- [ ] Implement secret resolution via GitHub Secrets API
      Motivation: The worker container needs to fetch and decrypt secrets required for the job steps.
      Things to consider: Using the installation token to query the Secrets API, handling encrypted values if necessary.
      Importance: 5
      Cite references: [worklog: 2026-02-10-0853](worklogs/2026-02-10-0853-direct-github-pull.md)
- [ ] Add error handling for failed pre-warming
      Motivation: If Docker is down or image pull fails, the runner should fail gracefully or retry instead of starting in a broken state.
      Things to consider: Catching errors in `ensureImageExists`, potentially notifying the bridge of "unhealthy" status.
      Importance: 3
      Cite references: [worklog: 2026-02-09-2324](worklogs/2026-02-09-2324-runner-boot-logic.md)
- [ ] Implement volume mapping for workspace persistence
      Motivation: Complex jobs often require file sharing across steps or persistent workspaces.
      Things to consider: Creating temporary local volumes or bind mounts for the worker containers.
      Importance: 4
      Cite references: [worklog: 2026-02-09-2316](worklogs/2026-02-09-2316-docker-environment-config.md)
- [ ] Configure `GHCR` authentication
      Motivation: Support pulling private images for custom worker environments.
      Things to consider: Passing credentials to `dockerode` for authenticated pulls.
      Importance: 2
      Cite references: [worklog: 2026-02-09-2324](worklogs/2026-02-09-2324-runner-boot-logic.md)
- [ ] Secure Bridge API with API Key
      Motivation: Prevent unauthorized job fetching.
      Things to consider: Verify `BRIDGE_API_KEY` in `src/bridge.ts` and Bridge headers.
      Importance: 3
- [ ] Update Runner to validate its own presence via the Bridge response
      Motivation: Ensure the Runner only proceeds if the Bridge has correctly identified it and marked it as online.
      Things to consider: The Bridge now returns `{ username, jobs }`. The Runner should verify this username.
      Importance: 4
      Cite references: [worklog: 2026-02-11-1535](worklogs/2026-02-11-1535-github-installation-tokens.md)
- [ ] Verify the full flow with the real Runner agent
      Motivation: Confirm that the on-demand tokens work correctly when used by the actual runner agent to pull job specs.
      Things to consider: Timing of token generation vs. usage.
      Importance: 5
      Cite references: [worklog: 2026-02-11-1535](worklogs/2026-02-11-1535-github-installation-tokens.md)
