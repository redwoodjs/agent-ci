---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Improve error hints when fetching remote reusable workflows from private repositories. GitHub returns HTTP 404 (not 401/403) when authentication is missing or insufficient for a private repo — to avoid leaking repo existence — so the 404 path now emits the same auth guidance as the 401/403 path, including instructions to run `gh auth login` and use `--github-token`. The hint also distinguishes between the no-token case (how to provide one) and the token-provided case (scope / fine-grained permission / SSO authorization may be missing).
