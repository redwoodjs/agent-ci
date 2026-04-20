---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Add a `proof` field to `compatibility.json` rows pointing at the workflow files that exercise each feature end-to-end. Internal field — not rendered in the markdown table or on the website. The `compat:gen` script fails if any listed proof path does not resolve on disk, so a file rename can't silently break a compatibility claim.

Refs #292.
