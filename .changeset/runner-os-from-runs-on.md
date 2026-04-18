---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

fix(workflow): expand `${{ runner.os }}` / `${{ runner.arch }}` from the job's `runs-on:` label instead of hardcoding Linux/X64. macOS jobs (e.g. `runs-on: macos-14`) now expand to `macOS`/`ARM64`, matching GitHub-hosted runner behavior and making conditionals like `if: runner.os == 'macOS'` work under tart-backed VM execution (#279).
