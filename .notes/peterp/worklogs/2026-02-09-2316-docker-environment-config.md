---
title: Configuring Docker Environment for Job Execution
date: 2026-02-09 23:16
author: peterp
---

# Configuring Docker Environment for Job Execution

## Summary

We containerized the `machinen-runner` and implemented a robust job execution system using Docker. The runner now spawns worker containers that mirror the GitHub Actions `ubuntu-latest` environment, injects dynamic environment variables per job, and preserves containers upon failure for easier debugging.

## The Problem

Jobs needed to run in an environment consistent with GitHub Actions to ensure portability and reliability. We needed to:

- Provide a containerized runner.
- Spawning worker containers from within the runner (Docker-out-of-Docker).
- Mirror the GitHub `ubuntu-latest` environment.
- Inject secrets and environment variables provided in the job payload.
- Persist containers when a job fails (non-zero exit code).

## Investigation & Timeline

- **Initial State:** `machinen-runner` was a bare TypeScript application with a simulation stub in `executor.ts`.
- **Attempts:**
  - **Native HTTP approach:** Initially explored using Node's `http` module to communicate with `/var/run/docker.sock` to avoid extra dependencies.
  - **Image Research:** Identified `ghcr.io/catthehacker/ubuntu:act-latest` as the best Docker-equivalent for the `ubuntu-latest` VM environment used in GitHub Actions.
  - **Reverted to Dockerode:** Switched to the `dockerode` library for more reliable socket interaction, image pulling (with progress tracking), and container management.
  - **Environmental Logic:** Refined the `docker-compose.yml` and `executor.ts` to distinguish between runner boot environment and job-specific environment variables.

## Discovery & Key Findings

- GitHub Actions' `ubuntu-latest` is a full VM; `catthehacker/ubuntu:act-latest` is the community standard for replicating this specific environment inside Docker (used by the `act` tool).
- Encountered `EPERM` issues during local verification (e.g., `npm error path /Users/peterp/.npm/_cacache/tmp/... operation not permitted`), likely due to macOS permission restrictions or OrbStack path sharing.

## Resolution

1.  **Dockerfile:** Created a production build for the runner using `node:22-bookworm`.
2.  **Docker Compose:** Set up `docker-compose.yml` to mount the Docker socket and pass through bridge configuration.
3.  **Executor Logic:** Implemented `executor.ts` using `dockerode` to:
    - Check for/pull the `act-latest` image.
    - Create containers with `job.env` variables injected.
    - Stream logs and capture exit codes.
    - Preserve containers on error.

## Next Steps

- [ ] Update bridge API to include necessary GitHub secrets in the `env` field of the job payload.
- [ ] Implement volume mapping for workspace persistence if jobs require file sharing beyond environment variables.
