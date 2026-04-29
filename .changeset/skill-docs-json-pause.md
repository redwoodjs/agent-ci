---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Update agent-facing skill docs (`packages/cli/SKILL.md`, top-level `skills/agent-ci/SKILL.md`) to cover the `--json` NDJSON event stream and the exit-77 pause contract added in #315 / #289. Internal `agent-ci-dev` command + pi skill switch from plaintext "Step failed" grep to NDJSON event matching for more robust pause/finish detection. Stale "no pipes / no redirects" warnings in the experimental skill-eval variants are corrected — pipes and redirects are safe with `--pause-on-failure` now that the launcher detaches automatically.

Refs #289, #315.
