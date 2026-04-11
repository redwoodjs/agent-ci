---
"@redwoodjs/agent-ci": minor
"dtu-github-actions": minor
---

Add pluggable runner image via `.github/agent-ci.Dockerfile` convention (#208).

agent-ci now discovers a user-provided Dockerfile at `.github/agent-ci.Dockerfile` (or `.github/agent-ci/Dockerfile` for builds with a COPY context), hashes its contents, builds it locally via `docker build`, and uses the resulting `agent-ci-runner:<hash>` tag as the default runner image. Edits to the Dockerfile produce a new hash and trigger an automatic rebuild; identical contents reuse the cached image.

This closes the long-standing gap where the minimal `ghcr.io/actions/actions-runner:latest` image lacks `build-essential`, `python3`, and other toolchains that GitHub's hosted `ubuntu-latest` VM ships preinstalled. Workflows that run green on GitHub but fail locally with `linker 'cc' not found` or similar can now opt into a richer image by dropping a 5-line Dockerfile into `.github/`.

Resolution order (highest wins):

1. Per-job `container:` directive (unchanged)
2. `AGENT_CI_RUNNER_IMAGE` environment variable
3. `.github/agent-ci/Dockerfile` (directory form, supports COPY)
4. `.github/agent-ci.Dockerfile` (simple form, empty context)
5. `ghcr.io/actions/actions-runner:latest` (unchanged default)

Also adds an error-hint heuristic: when a step fails with a "command not found" pattern for common tools (`cc`, `gcc`, `make`, `python3`, `pkg-config`) and the user is still on the default image, the failure summary includes a ready-to-paste Dockerfile snippet pointing at the fix. See `packages/cli/runner-image.md` for full documentation.
