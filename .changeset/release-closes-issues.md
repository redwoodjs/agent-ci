---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Release workflow now closes referenced issues on publish instead of on version-PR merge.

`pnpm run version` captures `Closes|Fixes|Resolves #N` references from pending changesets into `.release-closes.json`, pairs each with the PR that introduced the changeset, and rewrites the keywords to `Refs #N` in the changeset bodies so the "chore: version packages" PR does not close them on merge. After `changesets/action` publishes, a new step reads `.release-closes.json` and closes each issue with a `Closes Issue #N via PR #M.` comment.
