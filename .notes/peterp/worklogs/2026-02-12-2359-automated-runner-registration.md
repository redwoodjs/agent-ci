---
title: Automated Unique Runner Registration
date: 2026-02-12 23:59
author: peterp
---

# Automated Unique Runner Registration

## Summary

Successfully implemented an automated, unique registration flow for on-demand runners. The Bridge now handles registration token generation via GitHub App authentication, and Runners register themselves with unique names and the `machinen` label on startup.

## The Problem

Runners were failing to start or pick up jobs due to:

1. **Manual Configuration Needed**: The `actions-runner` image required explicit `./config.sh` execution.
2. **Permission Issues**: The Bridge lacked `Actions: write` and `Administration: write` permissions to fetch tokens.
3. **Name Collisions**: Duplicate runner names caused "Session already exists" errors in GitHub.
4. **Label Mismatch**: Runners lacked the `machinen` label required by workflows.

## Investigation & Timeline

- **Initial State:** Runners were mount-binding host identity files and required manual registration tokens.
- **Attempts:**
  - Implemented `/api/registration-token` endpoint in Bridge.
  - Encountered `422 Unprocessable Entity` (Missing Permissions).
  - Encountered `403 Forbidden` (Required Administration access).
  - Run without `config.sh` caused "Not configured" error.
  - Added unique names and labels to the registration command.

## Discovery & Key Findings

- The official `actions-runner` Docker image needs an explicit `./config.sh` call before `./run.sh` can work.
- GitHub self-hosted runner management through Apps requires both **Actions** and **Administration** write permissions.
- Ephemeral runners do not need host identity persistence; they generate and discard their own credentials on the fly.

## Resolution

The final solution involves:

- **Bridge**: Authenticates as a GitHub App to provide registration tokens on-demand.
- **Runner**: Appends high-entropy suffixes to names (e.g., `machinen-runner-1-abcde`) and runs a combined `config.sh && run.sh` command.

## Next Steps

- [ ] Monitor runner churn in GitHub Settings to ensure ephemeral cleanup is working.
- [ ] Refactor common registration logic into a shared utility if multiple runner types are added later.
