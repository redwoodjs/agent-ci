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

### Validation status (Doc B indexing)

While tailing `dev-justin`, I indexed a later Cursor conversation (Doc B):

- Document id: `cursor/conversations/07230886-c5d6-42c2-a6ff-08c49f90b2d3/latest.json`
- Engine indexing ran, but with a delay between enqueue and delivery.
- The doc was re-indexed multiple times as the conversation evolved.
- In the observed runs, correlation reused an existing parent id for the first macro moment rather than showing a fresh Smart Linker attachment decision.

This makes it hard to confirm the cross-document attachment behavior (Doc B under Doc A) using only these logs.

### Validation plan (next step)

I want a clean slate for Moment Graph state so I can run the A/B fixture with clear logs and without re-index reuse confusing parent decisions.

Plan:

- Add a debug-only endpoint that deletes all Moment Graph rows from the DO SQLite tables (moments and related state).
- Guard it so it is only enabled in non-production environments and requires the existing admin API key.
- Re-ingest Doc A, then ingest Doc B and confirm Smart Linker proposes a parent in Doc A's timeline.

### Implementation status (Moment Graph reset endpoint)

I added a debug endpoint to clear Moment Graph storage so the Doc A / Doc B fixture can be rerun without interference from older moments.

Changes:

- Added a Moment DB helper that deletes all rows from:
  - `moments`
  - `micro_moments`
  - `document_structure_hash`
- Added a route: `POST /rag/debug/clear-moment-graph`
  - For now it is gated only by the existing API key interruptor. Any additional environment checks were removed to unblock testing. I can tighten this later.

Validation:

- Calling the endpoint on `machinen-dev-justin` returned `{ "success": true }`.
- A follow-up call to `/rag/timeline` for Doc A returned `No moments found for document`, which is consistent with the DB being cleared.

Manual invocation:

```bash
# dev-justin
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  "https://machinen-dev-justin.redwoodjs.workers.dev/rag/debug/clear-moment-graph"

# local
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  "http://localhost:8787/rag/debug/clear-moment-graph"
```

### Plan update (namespace-based test isolation)

The reset endpoint clears the DO SQLite tables, but it does not clear Vectorize. That leaves stale subject/moment vectors in `SUBJECT_INDEX` / `MOMENT_INDEX`, which can produce high-scoring candidates that no longer exist in the DO database. This makes Smart Linker test runs hard to interpret.

Instead of trying to delete vectors, I want to namespace the entire Moment Graph stack so a clean test run is just a config change.

Plan:

- Add `MOMENT_GRAPH_NAMESPACE` to `.dev.vars` and `.dev.vars.example`.
- Use `MOMENT_GRAPH_NAMESPACE` to prefix the DO database namespaces passed to `createDb(...)` for:
  - Moment Graph storage (MomentGraphDO SQLite)
  - Engine indexing state (EngineIndexingStateDO SQLite)
- For Vectorize, avoid creating separate indices per namespace. Instead:
  - Include `momentGraphNamespace` metadata on writes to `MOMENT_INDEX` and `SUBJECT_INDEX`.
  - Filter query results in code to only consider matches where `momentGraphNamespace` matches the current configured namespace.

Validation:

- Set `MOMENT_GRAPH_NAMESPACE` to a fresh value, deploy, then re-run:
  - index Doc A (should create a root subject in the current namespace)
  - index Doc B (Smart Linker should attach under Doc A’s timeline, using only candidates from the same namespace)

Follow-up:

- Remove the reset endpoint and the DB clearing helper once the namespace approach is in place, since changing `MOMENT_GRAPH_NAMESPACE` becomes the reset mechanism.

### Validation status (Doc A indexing, dev-justin)

I tailed `machinen-dev-justin` and captured a full Doc A indexing run (despite the tail entering sampling mode later).

Observed from the logs:

- Document id: `cursor/conversations/6e15efeb-263c-4ff0-94db-17277c76f50e/latest.json`
- Micro moments extracted: 87
- Macro moments synthesized: 2

Smart Linker:

- Queried for macro moment 0 and returned raw candidate ids with high scores.
- Produced no attachment proposal for Doc A (so the first macro moment stayed a root moment).

Correlation / storage:

- Macro moment 0
  - reuseExisting: true (this suggests Doc A has already been indexed in the current namespace)
  - moment id: `caddb526-8d6c-4132-9ab8-92e77211774c`
  - micro paths hash: `8981f5c0f0a816f8ba69bad65742fd264472dac7aa5723f75b521eb04268d3e3`
  - micro paths count: 15
  - parent id: null
- Macro moment 1
  - reuseExisting: false
  - moment id: `20dc4f16-0551-40f2-9399-025f408e78f5`
  - micro paths hash: `4d50efc51520c58509ed89fa2a7c35b10899fb874c28237fc113839df76bdee8`
  - micro paths count: 72
  - parent id: `caddb526-8d6c-4132-9ab8-92e77211774c`

Notes:

- The Smart Linker candidate list is printed before namespace filtering, so it can still show ids that will be filtered out by metadata checks. The attachment decision is the authoritative signal.

### Validation status (Doc A indexing, fresh namespace run)

I reran Doc A indexing after changing `MOMENT_GRAPH_NAMESPACE` to a fresh value, to force a clean DO SQLite namespace and isolate Vectorize reads by metadata.

Observed from the logs:

- Document id: `cursor/conversations/6e15efeb-263c-4ff0-94db-17277c76f50e/latest.json`
- Micro moments extracted: 91
- Macro moments synthesized: 2

Smart Linker:

- Queried for macro moment 0.
- Produced no attachment proposal for Doc A (so the first macro moment stayed a root moment).

Correlation / storage:

- Macro moment 0
  - reuseExisting: false
  - moment id: `176f0c30-b4fa-498d-b3e3-c6b652e80a0f`
  - micro paths hash: `56a3286392b2c3fc13e8d361629f5bf0001ea1b6ec4a281ec0e3475c8ade7b07`
  - micro paths count: 27
  - parent id: null
- Macro moment 1
  - reuseExisting: false
  - moment id: `979d477a-30f3-4de9-829b-94e63453dbf2`
  - micro paths hash: `91d5004e2f230b2d4fa1c3a5c0ef26462f172102928406129f65772a353387f4`
  - micro paths count: 64
  - parent id: `176f0c30-b4fa-498d-b3e3-c6b652e80a0f`

### Validation status (Doc B indexing, minimal content)

I tried to use this chat as Doc B, but it did not contain enough workstream content to exercise Smart Linker.

Observed from the logs:

- Document id: `cursor/conversations/979d250a-d6ac-4567-a76d-961c1897d370/latest.json`
- Micro moments extracted: 2
- Macro moments synthesized: 2

Smart Linker:

- Returned high-scoring candidates for macro moment 0.
- Produced no attachment proposal, so Doc B became its own root timeline.

Correlation / storage:

- Macro moment 0:
  - reuseExisting: true
  - moment id: `3e70b201-9687-44a7-a442-234bedd4f6c8`
  - parent id: null
- Macro moment 1:
  - reuseExisting: false
  - moment id: `87a5fc4f-4a67-432c-b7c8-ceb0cf2ed7d0`
  - parent id: `3e70b201-9687-44a7-a442-234bedd4f6c8`

Interpretation:

- The document only contained status nudges ('bump', 'stand by'). Even with semantic search, there is not enough signal to associate it with Doc A's subject.

### Experiment plan (micro-moment concatenation query for subject assignment)

This chat scenario is realistic: sometimes a follow-up document starts with low-signal messages, but I still want it grouped under the same subject/workstream.

Experiment:

- Change Smart Linker so the query embedding is built from concatenated micro-moment text for the document, rather than a synthesized macro moment title/summary.
- Apply a deterministic cap (to control prompt size and cost).
- Keep the existing namespace metadata filtering.
- Do this directly in the plugin rather than keeping multiple query modes.

Expected outcome:

- For documents that contain a mix of low-signal and high-signal micro moments, subject matching should become less sensitive to where the turning point lands in the macro synthesis.

### Validation status (Doc A indexing, fresh namespace, micro-concat query)

I reran Doc A indexing in a fresh namespace after switching Smart Linker to build its query embedding from concatenated micro-moment text (with a deterministic cap).

Observed from the logs:

- Document id: `cursor/conversations/6e15efeb-263c-4ff0-94db-17277c76f50e/latest.json`
- Micro moments extracted: 94
- Micro moments loaded: 94
- Macro moments synthesized: 2

Smart Linker:

- Query source: `micro-concat`
- Micro moments used: 13 (out of 94)
- Produced no attachment proposal for Doc A (so the first macro moment stayed a root moment).

Correlation / storage:

- Macro moment 0
  - reuseExisting: false
  - moment id: `ba6c0e93-e0f4-4c40-ad35-7463028cc4d2`
  - micro paths hash: `817da82c0583d8f2dcaef09f37325c2b980237f9967d984271c085afabcddf10`
  - micro paths count: 94
  - parent id: null
- Macro moment 1
  - reuseExisting: false
  - moment id: `2a26a3ab-3941-4a11-9afc-795cc8f41012`
  - micro paths hash: `5751d5da526849b5c149ee086c34e99a690ee8cbaa98110ecdbac19b4b5ef121`
  - micro paths count: 71
  - parent id: `ba6c0e93-e0f4-4c40-ad35-7463028cc4d2`

### Implementation note (Smart Linker candidate rejection logging)

The Smart Linker logs showed high-scoring Vectorize candidates but still produced no attachment proposal. The existing logs only listed candidate ids/scores, which was not enough to see which filter rejected each match.

I added per-candidate logging to the Smart Linker no-attachment case:

- For each candidate: namespace in metadata, document id in metadata, subject row existence, same-document check, root check, threshold check.
- This is emitted only when no attachment is produced, to keep successful runs less noisy.

### Dev workflow update (local resync loop) and performance hurdle (cold micro cache)

I took a digression to make Smart Linker iterations faster:

- Run a local dev server and keep it running.
- Trigger indexing manually for specific R2 keys (bypassing R2 event delivery delay).
- Override the Moment Graph namespace per run so A/B fixtures can share a namespace without editing `.dev.vars` each time.
- Write logs to a file so I can run indexing, then inspect a stable log after.

Workflow:

- Start dev server with log capture:
  - `npm run dev:log` (writes to `/tmp/machinen-dev.log`)
- Trigger indexing inline (no queue wait):
  - `POST /rag/admin/resync` with `mode: inline`, `r2Key` or `r2Keys`, and `momentGraphNamespace`
- Use a shared namespace for the A/B fixture, so Doc A then Doc B are forced into one isolated test run.

Hurdle discovered:

On a fresh namespace (and/or a fresh doc), micro moment processing is slow because the micro cache is cold. The engine currently does:

- for each extracted micro moment:
  - read cache row
  - on miss: call the LLM to summarize that micro moment
  - on miss: call the embedding model for that summary
  - upsert the summary + embedding

So the cold-start path is one LLM call per micro moment, plus one embedding call per micro moment. In the log for Doc A this showed up as many sequential `micro cache miss` lines and many `llm` calls, which makes the first indexing run take long enough that it becomes the next bottleneck in the dev loop.

What I plan to do about it:

- Batch micro moment summarization:
  - Collect the cache misses first.
  - Send micro moment contents to the LLM in batches (size capped).
  - Require the model to return machine-readable output (array of summaries aligned to inputs).
  - Validate shape and length before writing results. If parsing fails, fall back to per-item summarization for that batch.
- Batch embeddings:
  - The embedding call already accepts an array input (`text: [...]`), so I can embed a whole batch of summaries in one request and then map results back to micro moments by index.

This keeps the existing caching behavior (warm runs are fast), but reduces the cold-start cost so the first run in a namespace is less dominated by dozens of separate AI calls.

Decision update:

- The current plugin API has `summarizeMomentContent` as a single-item hook. That shape blocks plugin-owned batching because the plugin never sees the batch.
- I am going to change the hook to be batch-based (`summarizeMomentContents`) so a plugin can do one LLM call per batch and return summaries aligned to inputs.
- Embedding batching stays engine-owned since the embedding model already accepts array input.

### Implementation status (micro moment batching)

I implemented the first version of batching for cold micro-moment caches.

Plugin API change:

- Replaced the single-item micro moment summarization hook with a batch hook:
  - `summarizeMomentContent(content)` -> `summarizeMomentContents(contents)`

Engine changes:

- The engine now loads existing micro moments for the document once and builds an in-memory map by path.
- It collects the cache misses (missing summary and/or embedding).
- It calls the plugin batch hook over cache misses in batches.
- It generates embeddings for the returned summaries in a single embedding call per batch, and upserts each micro moment row.
- If the batch embedding call fails or returns an unexpected shape, it falls back to per-item embedding generation for that batch.

Plugins updated:

- Cursor plugin: implements `summarizeMomentContents` by asking for a fixed line format (`S1|...`) and parsing by index.
- Default plugin: implements the same batch interface, returning a fallback summary per item on parse errors.

Operational note:

- Batch size is currently controlled by `MICRO_MOMENT_SUMMARY_BATCH_SIZE` (defaults to 10).

### Validation note (batching: context window + output parsing)

First local runs surfaced two practical batching issues:

- Some batches can exceed the model context window, depending on how long the micro moment contents are.
- The model output sometimes includes non-JSON preamble, code fences, or truncated arrays, which makes strict JSON parsing fail.

Adjustments:

- Cap each micro moment content passed into the batch summarizer (`MICRO_MOMENT_SUMMARY_ITEM_MAX_CHARS`, default 2000).
- Cap total batch input size (`MICRO_MOMENT_SUMMARY_BATCH_MAX_CHARS`, default 10000).
- Use a single-item path for summarization to avoid JSON parsing for batches of size 1.
- Set LLM options for the batch hook (temperature 0, higher max output tokens) to reduce truncation.
- Stop requesting JSON output from the model for batch summaries. Instead, request a fixed line format (`S1|...`) and parse by index.

### Design note (generalizing micro compression across sources)

The batch summarization work surfaced a bigger design issue:

- If micro summarization is a plugin hook, each ingestion source ends up re-implementing:
  - output shape constraints
  - parsing / validation
  - batching heuristics and caps

This does not scale well across sources.

Alternate direction to get more mileage:

- Keep plugins responsible only for extracting deterministic raw events:
  - a stable id/path per event
  - raw text content
  - author + time (when available)
- Move “micro compression” into the engine:
  - The engine batches raw events purely for performance (token/size caps), not for semantic boundaries.
  - For each batch, the LLM produces a markdown-ish list of “what happened” items.
  - These items do not need to be 1:1 with the raw inputs.

The missing piece is provenance:

- If the compression output does not map back to inputs, we lose stable provenance, and we make idempotent re-indexing harder.
- A compromise is to have the engine request that each output item includes an input range or list of indices, so the engine can:
  - cache compression results per batch (keyed by a hash of the raw event ids)
  - keep a stable membership mapping for later drill-down

If this direction holds up, it would let us simplify the plugin API (plugins emit raw events; the engine owns batching, compression, caching, and downstream synthesis).

### 2025-12-14 (time not recorded) - Status update (local dev logs: Smart Linker decision)

I ran local dev with log capture to continue the Doc A / Doc B Smart Linker validation loop.

Doc A run (local dev):

- Document id: `cursor/conversations/6e15efeb-263c-4ff0-94db-17277c76f50e/latest.json`
- Micro moments loaded: 12
- Macro moments synthesized: 2
- Smart Linker:
  - Query source: `micro-concat`
  - Micro moments used: 12 (out of 12)
  - Returned candidates with scores above the threshold (example: score `0.7814766` with threshold `0.75`)
  - Produced no attachment proposal
  - Decision logging shows every candidate was rejected with `rejectReason: 'namespace-mismatch'`
  - The log shows `expectedNamespace: 'Clumsy Odin Thrilled Raisins'` and `matchNamespace: 'default'` for the rejected candidates
- Correlation / storage:
  - Macro moment 0:
    - reuseExisting: false
    - moment id: `5b793074-2f66-4905-9492-b0502f7df6a5`
    - micro paths hash: `1719d44fbc007913275af0da4aaeb8e8c132adc6f8a58cb09bac6ddb1f7d9ea2`
    - parent id: null
  - Macro moment 1:
    - reuseExisting: false
    - moment id: `66d1ebb6-bb4d-4504-b086-47c74235c302`
    - micro paths hash: `2a465b54a7e157970827b8702f2b18855732d7abc43489abd375d0053d0d2a07`
    - parent id: `5b793074-2f66-4905-9492-b0502f7df6a5`

Doc B run (local dev, minimal content):

- Document id: `cursor/conversations/979d250a-d6ac-4567-a76d-961c1897d370/latest.json`
- Micro moments loaded: 2
- Macro moments synthesized: 2
- Smart Linker:
  - Query source: `micro-concat`
  - Micro moments used: 2 (out of 2)
  - Returned candidates with scores near / above the threshold (example: score `0.7631746` with threshold `0.75`)
  - Produced no attachment proposal
  - Decision logging shows every candidate was rejected with `rejectReason: 'namespace-mismatch'`
  - The log shows `expectedNamespace: 'Clumsy Odin Thrilled Raisins'` and `matchNamespace: 'default'` for the rejected candidates

Interpretation from these logs:

- The Smart Linker rejection reason is not “below threshold” or “same document” or “not a root”. It is consistently “namespace mismatch”.
- The candidate entries show `matchNamespace` as `default`, which suggests the namespace metadata being checked by Smart Linker is either missing on the Vectorize matches or not being returned on query, so the code treats it as `default` and rejects it when a non-default `momentGraphNamespace` is configured for the run.

### 2025-12-14 (time not recorded) - Investigation note (namespace mismatch vs query-time filtering)

The `namespace-mismatch` outcome looks odd at first (both Doc A and Doc B were indexed under the same namespace), but the logs point at a more specific failure mode:

- Smart Linker queries `SUBJECT_INDEX` without a metadata filter.
- Vectorize returns topK matches across all previously indexed vectors.
- Smart Linker then filters those matches in code by `momentGraphNamespace`.
- In a namespace-isolated test run, it is possible for all returned matches to be from other namespaces (or old vectors missing the namespace metadata, treated as `default`), which means the in-code filter drops everything and the run ends with `namespace-mismatch`.

In that situation, it is not that the system “is not using the namespace”. It is using it too late (after the vector search), which can cause topK starvation:

- The subject for Doc A might be correctly written with `momentGraphNamespace: 'Clumsy Odin Thrilled Raisins'`, but if it is not among the global topK results for the Doc B query, it never reaches the in-code filter.

Proposed fix direction:

- When the configured Moment Graph namespace is not `default`, apply a Vectorize metadata filter at query time (`filter: { momentGraphNamespace: <namespace> }`) for subject/moment search.
- Keep the existing in-code filtering as a safety net, but do not rely on it as the primary isolation mechanism.

### 2025-12-14 (time not recorded) - Implementation status (namespace query filtering)

I implemented query-time namespace filtering for Moment Graph vector queries.

Changes:

- Smart Linker subject search now applies a Vectorize metadata filter when the effective namespace is not `default`:
  - `SUBJECT_INDEX.query(..., { filter: { momentGraphNamespace } })`
- `momentDb.findSimilarSubjects` and `momentDb.findSimilarMoments` now apply the same filter when the effective namespace is not `default`.
- The debug route `/rag/debug/query-subject-index` now applies the same filter when the effective namespace is not `default`.

Rationale:

- Without query-time filtering, topK results can be dominated by other namespaces (or older vectors missing namespace metadata), then dropped by the in-code filter. This can produce “namespace-mismatch” even when the correct in-namespace subject exists.

Local typecheck note:

- `npm run types` currently fails with unrelated TypeScript errors in other parts of the repo, so I did not use it as a validation signal for this change.

Next validation:

- Run Doc A then Doc B in a shared non-default namespace and confirm Smart Linker sees in-namespace candidates and produces an attachment proposal for Doc B when similarity is above threshold.

Note:

- I added always-on logs for vector upserts in `momentDb.addMoment` so we can see the `momentGraphNamespace` metadata being written to `MOMENT_INDEX` and `SUBJECT_INDEX` during indexing runs. This is intended for the current debugging loop and can be removed after the namespace behavior is confirmed.
