---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Stop the resource-mismatch smoke from queueing a phantom GitHub Actions job. The fixture in `.github/workflows/smoke-resource-mismatch.yml` declares `runs-on: ubuntu-latest-999-cores` to deterministically trigger the local resource-fidelity classifier, but its `pull_request_target` trigger meant GitHub also queued the job on every PR and waited indefinitely for a runner that does not exist. The trigger is now `workflow_dispatch:` only, and `agent-ci run --all` now treats `workflow_dispatch:`-only workflows as relevant so the smoke is still exercised by local CI.
