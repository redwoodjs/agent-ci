# Changesets

This repo uses [changesets](https://github.com/changesets/changesets).

Any PR that modifies code under `packages/**` **must** include a changeset
describing the change and the intended version bump. Create one by adding a
new markdown file to this directory, e.g. `.changeset/my-change.md`:

```markdown
---
"@example/cli": patch
---

Short description of the change.
```

Bump types: `patch` (bug fix), `minor` (new feature), `major` (breaking).
