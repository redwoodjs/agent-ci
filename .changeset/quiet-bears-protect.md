---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Harden the ephemeral DTU control plane: require a cryptographically secure, in-process control token for seed/start-runner/dump endpoints (including trailing-slash routes), fail closed when secure randomness is unavailable, and reject runner log paths that escape the run log root through symlinks. Also remove shell execution from compare handling and update vulnerable dependencies, including the unpatched `decompress` transitive dependency.
