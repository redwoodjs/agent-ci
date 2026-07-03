---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Harden the ephemeral DTU control plane by requiring an in-process token for internal seed/start-runner/dump endpoints, constraining runner log paths, and removing shell execution from compare handling.
