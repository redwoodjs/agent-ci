---
"@redwoodjs/agent-ci": minor
"dtu-github-actions": patch
---

Persist the latest run result per worktree to `$AGENT_CI_STATE_DIR` (or OS-default state dir) as JSON, so external consumers (tmux panes, status bars, editor integrations) can read the current branch's CI status without re-running the tool or scraping human output.

The file is written atomically after every `agent-ci run` / `agent-ci run --all` and keyed by `<branch>.<worktree-hash>.json` under `<org>/<repo>/`, so two worktrees on the same branch don't stomp each other. Includes `headSha` so consumers can detect stale results themselves.

Closes #288
