## Work Log: Iteration 1 - Smart Linker (Cursor Cross-Document)

**Date:** 2025-12-12

### Problem and scope

The current Moment Graph implementation delivers narrative answers within a single document. The next planned work (Smart Linker, Truth Seeker, more data sources) has a sequencing problem:

- Adding data sources without linking does not validate cross-document narrative stitching.
- Building linking before adding data sources can feel hard to validate, because there is not enough cross-document data to exercise it.

Each iteration should have a deliverable that can be validated with a repeatable fixture, and should still be useful if work stops after that iteration.

The Bicycle iteration work established:

- Micro-moments ingestion and caching
- Macro-moment synthesis
- Subject-first querying, where root macro-moments are indexed as subjects

Iteration 1 goal:

- Implement Smart Linker for Cursor-only data, so multiple Cursor documents can attach into one subject timeline.

Iteration 1 non-goals (deferred):

- Explicit correlation hints (Truth Seeker)
- Drill-down to evidence chunks (R2 fetch vs evidence locker filtering is deferred)
- GitHub/Discord ingestion
- General cross-source normalization

### Decisions: validate linking using Cursor-only data

Use multiple Cursor conversations (multiple documents) as the stand-in for 'multiple sources'.

This keeps the surface area small:

- There is already a working ingestion and query path for Cursor.
- I can create several Cursor documents that are intentionally related but separated, then re-ingest them repeatedly to validate behavior.

This avoids waiting for GitHub/Discord ingestion while still testing the cross-document linker in a way that is representative of the eventual system.

### Decisions: correlation is a first-class step, with hookable strategies

Macro moments are first-class entities. Correlation decides, for each synthesized macro moment:

- whether it maps to an existing stored moment or requires a new stored moment
- whether it should be a root or a child of an existing moment

Correlation should be extensible so different correlation strategies can be tested without rewriting the engine. The correlation mechanism is expressed as a strategy hook that returns a correlation plan. The engine applies the plan (writes/updates moments, sets parent relationships, updates indexes) so behavior remains consistent.

### Decisions: stable provenance mapping on macro moments (membership JSON blob)

Macro moments need stable provenance for:

- Traceability for drill-down later
- Idempotent re-indexing without relying on semantic similarity for identity
- Debuggability for linking decisions

The provenance mapping for a macro moment is an ordered JSON list of the contributing micro moment references. A micro reference is based on the per-document path identifier produced by the plugin. The mapping is stored as a JSON blob to avoid many-row write patterns in DO SQLite.

An additional derived membership key (hash of ordered micro paths) is used as the stable identifier for macro moments within a document.

Update semantics for existing moments:

- If correlation maps a synthesized macro moment onto an existing stored moment, the existing moment is updated in place (title/summary/provenance and parent, as needed).

### Validation fixtures and acceptance checks

Fixtures:

- Document A: earlier conversation in a workstream (problem discovery, early attempts, partial conclusions).
- Document B: later conversation in the same workstream (implementation decisions, follow-up fixes).

The specific topic/examples can be selected later. The fixture constraint is that A and B are related but do not share many exact phrases, so semantic similarity is required.

Optional negative fixture:

- Document C: unrelated topic (should not merge into the A/B subject).

Acceptance checks:

- Correlation behavior (identity)
  - Re-ingesting A or B should not create unbounded duplicates for the same macro moments. Macro moments should be matched via membership keys and updated in place.
- Correlation behavior (parenting)
  - After ingesting A then B, the first macro moment from B should attach under the existing subject for A when similarity is above the threshold.
  - Document C should not attach under the A/B subject.
- Query behavior
  - A narrative query related to the A/B workstream should return a timeline that includes macro moments from both documents.
  - A narrative query related to the unrelated topic (C) should not pull in A/B.

What I can demo after Iteration 1:

- A single subject timeline that spans multiple Cursor documents, with a narrative answer that includes the causal context that previously lived in a separate document.

Open questions:

- Thresholding details and tie-breaking should be tuned against the A/B/C fixtures, not guessed up-front.
- Drill-down design is deferred. Macro moments will store stable provenance (membership mapping to micro moments) so later work can choose between:
  - fetching source documents and extracting the referenced content, and/or
  - filtering evidence locker search using provenance.
- If subject merging turns out to be too destructive for future work, the alternative is to keep subjects separate but create explicit edges between subjects. That is out of scope for this iteration and can be revisited after there is a working merge-based baseline.

### Implementation notes (start)

Work begins by making macro moments identifiable and traceable:

- Persist macro moment membership as an ordered JSON list of contributing micro paths.
- Persist a derived membership hash to match macro moments on re-index.
- Correlation produces a plan per macro moment: reuse-or-create moment id, and parent id (root vs child-of-X).
- When a macro moment matches an existing stored moment, update it in place.

### Implementation status (progress update)

Completed work:

- Added macro moment membership fields to Moment Graph storage:
  - `moments.micro_paths_json` (JSON blob)
  - `moments.micro_paths_hash` (hash of ordered micro paths)
  - unique index on `(document_id, micro_paths_hash)`
- Extended moment types and DB access:
  - `Moment` includes `microPaths` and `microPathsHash`
  - momentDb persists and loads these fields
  - momentDb includes a lookup helper to find an existing macro moment by `(documentId, microPathsHash)`
- Updated macro-moment synthesis so membership is deterministic:
  - synthesis prompt requests `INDICES` (1-based) rather than paths
  - indices are mapped to micro moments by position, then converted to `microPaths`
  - macro moment content is assembled from the member micro moments
  - macro moment createdAt/author are taken from the first member micro moment
- Refactored synthesis code into its own module:
  - moved into `src/app/engine/synthesis/synthesizeMicroMoments.ts`

Remaining work for Iteration 1:

- Implement correlation strategy hook + engine integration:
  - compute `microPathsHash` for each synthesized macro moment
  - determine reuse-or-create moment id per macro moment using `(documentId, microPathsHash)`
  - update in place for existing macro moments
  - decide parent for the first macro moment in a batch using Smart Linker (semantic match against subjects)
  - set parent for subsequent macro moments to the previous macro moment, unless overridden
  - apply the correlation plan (write/update moments and vector indexes)
- Implement Smart Linker strategy:
  - embed an aggregate of synthesized macro moment titles/summaries
  - query `SUBJECT_INDEX`
  - if above threshold, attach under the last moment in the matched subject's timeline
- Run validation fixtures:
  - ingest A then B and confirm B attaches under A’s subject
  - ingest C and confirm it does not attach under A/B
  - re-ingest A/B and confirm macro moments are updated in place rather than duplicating


