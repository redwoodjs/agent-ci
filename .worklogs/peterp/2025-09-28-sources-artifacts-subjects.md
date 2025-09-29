Title: Re-thinking data model: Sources → Artifacts → Subjects

Context

- Inputs include GitHub PRs/Issues, Linear, Zoom/Google Meet transcripts, Discord/Slack chat and audio.
- Need a normalized model capturing provenance (source), immutable captures (artifacts), and derived concepts (subjects).

Attempt 1: Extend current `entries` and `streams`

- Considered overloading `entries` to carry artifact data.
- Findings: `entries` are file line-range highlights and do not represent upstream objects like PRs or transcripts.
- Decision: Keep `entries` focused on code/file excerpts linked to subjects.

Attempt 2: Subjects-only model

- Considered creating subjects only and attaching provider metadata.
- Findings: Lacked lossless provenance and update handling for upstream changes.
- Decision: Introduce `artifacts` as first-class, immutable captures tied to `sources`.

Current solution

- Add `artifacts` table (immutable snapshots with providerId, contentHash, kind).
- Add `subjects` and `artifact_subjects` for many-to-many mapping.
- Keep `entries` and optionally link back to `artifact` for provenance.
- Base type and implementation type on `sources` guide prompts and ingestion behavior.

Next steps

- Create migrations 017–018.
- Implement ingestion interfaces and parsers per base type.
