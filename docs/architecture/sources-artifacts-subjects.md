Title: Sources → Artifacts → Subjects

Problem

- The system ingests heterogeneous inputs (GitHub, Linear, Zoom, Google Meet, Discord, Slack) that must be normalized for downstream analysis and UI.
- Current schema lacks explicit modeling of ingestion provenance, artifact shape, and subject extraction.

Model

- sources: Represents an integration instance that can produce artifacts.
  - Base type defines shared behavior and prompt guidance.
  - Implementation type defines provider-specific configuration and extraction logic.
- artifacts: Immutable records captured from sources (e.g., PR, issue, transcript, chat message batch, code diff, discussion thread).
  - Tied to a single source.
  - Contains normalized canonical content fields and provider-specific metadata.
  - Versioned by provider identity and content hash to support updates.
- subjects: Concepts derived from artifact parsing (e.g., ticket/topic/proposal entity).
  - Linked back to provenance via artifact relations and source lineage.
  - Used to group entries and drive stream views and prompts.

Key relations

- source 1—N artifacts
- artifact N—M subjects (via artifact_subjects)
- subject N—M entries (existing `entries` represent file line-range highlights associated to subjects)

Types

- source.baseType: enum
  - github_pr, github_issue, linear_ticket, zoom_transcript, gmeet_transcript, discord_audio, discord_chat, slack_chat
- source.implType: enum/string
  - e.g., github_app, github_token, slack_bot, discord_bot, linear_api
- artifact.kind: enum
  - proposal_for_change, code_diffs, discussion, ticket, transcript, chat

Canonical artifact fields

- id, sourceId, kind, providerId, providerUrl, title, summary, content, contentFormat, createdAt, updatedAt, capturedAt, contentHash, metadata (json)

Subject fields

- id, name, description, kind, status, createdAt, updatedAt

Prompt influence

- baseType and artifact.kind select prompt templates for parsing and summarization.
- Implementation type configures provider fetch and pagination behavior.

Migration outline

1. Create tables: artifacts, subjects, artifact_subjects.
2. Backfill artifacts from existing `sources` and any stored R2 bucket items using provider identity and content hashes.
3. Introduce parsers per baseType to emit subjects; store associations.
4. Update `streams` to reference subjects/artifacts explicitly instead of free-form arrays.
5. Keep existing `entries` but link to subjects (already present) and optionally to artifacts for provenance.

Task list

- Create `017_create_artifacts_table` migration
- Create `018_create_subjects_and_artifact_subjects` migration
- Update `entries` to add optional `artifact_id` column
- Add indexes: artifacts(sourceId, kind, capturedAt), artifact_subjects(artifactId, subjectId), subjects(name)
- Implement artifact ingestion interfaces per base type
- Implement parsers per base type to extract subjects
- Update `streams` usage to join subjects/artifacts rather than arrays
- Add admin pages: source detail, artifact list, subject list

API/UI impact

- Stream views fetch subjects with related entries and recent artifacts.
- Source detail shows artifacts timeline and parsing status.

Risks

- Artifact deduplication across updates; mitigate with providerId + contentHash.
- Large transcripts; store content in external storage and index excerpts.

Open questions

- Do subjects need versioning? For now, store latest plus provenance to artifacts.
- Which artifacts map to multiple kinds (e.g., PR has diffs and discussion)? Represent via artifact kind + metadata sections or separate artifacts linked by a parentId.
