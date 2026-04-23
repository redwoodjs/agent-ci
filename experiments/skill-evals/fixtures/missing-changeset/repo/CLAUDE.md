# Repo rules

## Changeset required

Every change that touches `packages/**` **must** include a changeset file at
`.changeset/<name>.md` with the package version bump. See
`.changeset/README.md` for the exact format.

CI enforces this — if `packages/**` changed and no new changeset exists, the
build fails.
