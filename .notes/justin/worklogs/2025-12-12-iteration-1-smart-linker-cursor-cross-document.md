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

### Implementation status (continued)

Completed since the previous update:

- Added a correlation hook to the plugin API (`Plugin.subjects.proposeMacroMomentParent`).
- Implemented `smartLinkerPlugin` which:
  - embeds one synthesized macro moment (title + summary)
  - queries `SUBJECT_INDEX` with match scores and a threshold
  - filters matches to root moments (no parent) and excludes moments from the current document
  - proposes an attach parent id as the last moment in the matched subject's timeline
- Updated macro-moment indexing so the first macro moment can attach under the proposed parent id.
- Updated subject search behavior:
  - `findSimilarSubjects` queries `SUBJECT_INDEX` without a filter and filters results in code to include only root moments.

### Validation status (current deploy)

Observed from indexing this current Cursor conversation (Document A):

- The synthesis produced 2 macro moments.
- Macro moment 1 was stored as a root moment and indexed into `SUBJECT_INDEX`.
- Macro moment 2 was stored as a child of macro moment 1 and was not indexed as a subject.

This establishes a baseline subject that Document B can attach to.

Concrete identifiers from the current deploy logs (Document A):

- Document id: `cursor/conversations/6e15efeb-263c-4ff0-94db-17277c76f50e/latest.json`
- Root moment id (Subject): `5e2b646b-12cc-4f1b-83a5-82449f72542d`
- Child moment id: `38f5faa4-f97b-4d84-a8f2-ec60bf824510`
- Child parent id: `5e2b646b-12cc-4f1b-83a5-82449f72542d`

### Validation status (Doc A run after redeploy)

Note: I accidentally deployed to production first, then redeployed to the environment where I was tailing logs (`cf:environment=dev-justin`). The identifiers below are from the later run in that environment.

Observed from the Document A indexing logs:

- Micro moments extracted: 65
- Macro moments synthesized: 2
- Smart Linker:
  - queried `SUBJECT_INDEX` and returned high-scoring candidates
  - returned no attachment proposal for this document (most likely due to candidate filtering: same document ids and non-root moments)
- Correlation / storage:
  - macro moment 1 was stored as a new root moment (no parent)
  - macro moment 2 was stored as a child of macro moment 1

Concrete identifiers from the later Document A run:

- Document id: `cursor/conversations/6e15efeb-263c-4ff0-94db-17277c76f50e/latest.json`
- Macro moment 1:
  - moment id: `c21fc0cd-c4cc-4841-82d9-b20298ba3c7c`
  - micro paths hash: `98c957af181794a83712523cf31a915fd70a266de35e05bd22f6e55ed0333127`
  - micro paths count: 13
  - parent id: null
- Macro moment 2:
  - moment id: `a40f7093-1ea9-4bfa-923a-1ec734c8b9d1`
  - micro paths hash: `90d1eb29b13787b25bdd434f371045de56946244dfcc9dcac5d298738005c15d`
  - micro paths count: 52
  - parent id: `c21fc0cd-c4cc-4841-82d9-b20298ba3c7c`

Note on synthesis membership:

- The LLM provided `INDICES` lists (1-13 and 14-65) for the two macro moments. This avoids path-string reproduction but still relies on the LLM selecting correct indices. If this turns out to be unstable, we can add stricter parsing/validation and fallbacks.

### Validation plan (next step)

Create a second Cursor conversation (Document B) as a continuation of the same workstream (deploy inspection, follow-up fixes, or tuning decisions). Index it and confirm, via logs, that:

- Smart Linker finds the subject from Document A and chooses an attachment.
- The first macro moment in Document B is stored with a parent that points into Document A's subject timeline (typically the last descendant).

Idempotency checks can be done later. For now the focus is confirming cross-document attachment on Document B.