---
title: Implementing Pull-based Job Spec from GitHub API
date: 2026-02-10 08:53
author: peterp
---

# Implementing Pull-based Job Spec from GitHub API

## Summary

We implemented a pull-based architecture for the Machinen runner where the worker container fetches its own job metadata and secrets directly from the GitHub API. This mirrors the official GitHub runner's security model and reduces the Bridge's role to a lightweight orchestrator and token provider.

## The Problem

Initially, the Runner host was responsible for pulling job details from the Bridge and injecting them into the container. This didn't match the GitHub runner's architecture where the worker (inside the container) retrieves its own "Plan" and encrypted secrets. We also needed to clarify the source of the `ACTIONS_RUNTIME_TOKEN` used for these requests.

## Investigation & Timeline

- **Initial State:** The Runner polled the Bridge, received a full job payload, and injected it into the container via environment variables.
- **Attempts:**
  - **Draft 1 (Pull from Bridge):** We first designed a flow where the container would fetch a "Job Spec" JSON from the Bridge using a temporary token.
  - **Feedback:** The user clarified that the container should fetch from the **GitHub API**, not the Bridge.
  - **Refinement:** We researched how the `ACTIONS_RUNTIME_TOKEN` works. It's an ephemeral token provided when a job is claimed. We updated the Bridge to act as the provider of this token (mapping to a scoped GitHub App Installation Token in production).
  - **Implementation:**
    - Updated `machinen-bridge` to extract GitHub metadata (Job ID, Repo) and provide a `GITHUB_TOKEN`.
    - Updated `machinen-runner` to inject these as `ACTIONS_RUNTIME_TOKEN`, `GITHUB_JOB_ID`, and `GITHUB_REPO`.
    - Updated the container command to use `curl` against `api.github.com`.

## Discovery & Key Findings

- **Bridge role:** In the pull-based model, the Bridge mimics the "GitHub Message Service". It doesn't need to hold the full job spec if the container has a valid token to fetch it directly from GitHub.
- **Token Sourcing:** The `ACTIONS_RUNTIME_TOKEN` is the key to decoupling the host runner from the job data.

## Resolution

- **Bridge Updated:** `src/api/routes.ts` now queues minimal GitHub metadata and a token.
- **Runner Updated:** `src/executor.ts` now injects these variables into the container without knowing the job details.
- **Container Command:**

```bash
curl -s -H "Authorization: Bearer $ACTIONS_RUNTIME_TOKEN" \
     "https://api.github.com/repos/$GITHUB_REPO/actions/jobs/$GITHUB_JOB_ID"
```

## Next Steps

- [ ] Implement actual "Plan" parsing inside the container (e.g., handling the JSON response from the GitHub API).
- [ ] Securely generate on-demand Installation Tokens in the Bridge (moving away from a persistent `GITHUB_TOKEN`).
- [ ] Implement secret resolution (fetching from GitHub Secrets API).
