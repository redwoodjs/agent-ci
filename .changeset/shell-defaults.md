---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Honor `defaults.run.shell` and step-level `shell:` for non-bash shells. The runner executes every `run:` step with bash regardless of `inputs.shell`, so the parser now wraps scripts that request `sh`, `python`, or `pwsh` with an explicit invocation of the requested interpreter (`sh -e <<'EOF' … EOF`). Workflow, job, and step scopes all use standard step-wins-over-job-wins-over-workflow precedence.

Closes #293.
