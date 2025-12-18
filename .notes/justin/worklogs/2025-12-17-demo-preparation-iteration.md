# Moment Graph query failure: "Too many API requests by single worker invocation" (prod-2025-12-16)

## Context
Queries against the `prod-2025-12-16` Moment Graph namespace are failing in the deployed worker. The logs show the narrative query path failing, then a fallback to the Evidence Locker path that is disabled, so the query produces no narrative context.

## Problem
The query handler hits Cloudflare's per-invocation API/subrequest limit ("Too many API requests by single worker invocation") during the narrative retrieval phase.

## Plan
- Extract the log segment around the failing queries and identify which narrative query steps are executed before the failure.
- Map those steps to code paths and count subrequests (Vectorize queries, Durable Object fetches, internal DB queries).
- Reduce the number of per-invocation subrequests by batching reads and/or lowering fanout.
- Re-run query locally and (if possible) validate on the deployed worker.

## Notes

### Observations from deployed logs (/tmp/out.log)
- Both failing queries log:
  - narrative namespace is `prod-2025-12-16`
  - `similarSubjects=0` (after warnings about subject ids missing in the DB)
  - `similarMoments=19`
  - then the narrative path throws `Error: Too many API requests by single worker invocation.`
  - fallback path is disabled (`evidenceLockerDisabled=true`)

The narrative path fails after logging `similarMoments=19`, and before any of the later narrative logs that would appear after resolving a root and building a timeline.

### Initial code mapping
- Query flow is in `src/app/engine/engine.ts` and calls:
  - `findSimilarSubjects` (Vectorize query + DB fetch)
  - `findSimilarMoments` (Vectorize query + DB fetch)
  - `findAncestors(bestMatch.id)`
  - `findDescendants(root.id)`

In `src/app/engine/momentDb/index.ts`:
- `findSimilarSubjects` and `findSimilarMoments` batch DB reads via `getMoments(ids)` (one DB query for <= 100 ids).
- `findAncestors` loops upward one parent pointer at a time and runs one DB query per step, with no cycle detection or max depth cap.
- `findDescendants` uses a recursive walk that runs one DB query per visited parent id (fetch children for each node).

### Hypothesis
The per-invocation API/subrequest limit is likely reached by a high fanout of DB queries in one of:
- an ancestor traversal that never terminates due to a parent cycle (example: a row whose parent id points to itself), or
- descendant traversal that issues one query per node and grows with timeline size.

The lack of cycle detection in ancestor traversal looks like a plausible way to hit the limit quickly without any other logs being emitted.

### Attempt: reduce DO query fanout in narrative traversal
I updated `src/app/engine/momentDb/index.ts` to remove per-node DB queries in narrative traversal:
- `findAncestors` now loads the id-parent map in one query, walks parents in memory with cycle detection and a max depth cap, then batches the full moment fetch.
- `findDescendants` now loads all moments in one query, builds a parent-to-children map in memory, walks the subtree with cycle detection and a max node cap, then returns a list sorted by timestamp.

This is intended to keep the narrative query path under Cloudflare's per-invocation request limit even when the graph is large or contains parent cycles.

## Scope update (demo preparation iteration)
This work log is also being used to track additional demo preparation changes after the subrequest-limit fix.

### Observation: queries return too many macro moments
The query output currently includes on the order of thousands of macro moments (example: ~1,688). This makes the output hard to use during a demo.

### Candidate direction: store a per-moment importance score and filter at query time
The current thinking is:
- Add an intrinsic importance score to each macro moment (float 0-1) at synthesis time.
- At query time, use embedding similarity (Vectorize) to retrieve candidate moments, then rerank and filter using the stored importance score.
- Avoid any per-moment model calls during query handling.

### Why this seems like the missing piece
The current system does two different things:
- retrieval: find a small set of moments that are semantically similar to the query
- expansion: traverse the graph to build a timeline around those moments

The retrieval step is already bounded, but the expansion step can produce a very large output. A per-moment importance signal gives us a way to bound expansion and output size without having to ask a model about each candidate.

### First iteration I think we should try
- Synthesis time:
  - store `importance` on each macro moment (float 0-1)
  - keep this definition intrinsic (not query-specific)
- Query time:
  - compute a combined score from (query similarity) and (stored importance)
  - apply budgets:
    - cap which moments are used as expansion seeds (top K by combined score)
    - cap how many descendants/ancestors are included (node budget)
    - cap the number of moments returned (output budget)
  - keep a small amount of ancestry context for the highest-scoring moments so the remaining output still reads like a timeline

### Notes on how to compute `importance` without query-time model calls
Two plausible options:
- Have the model emit an importance score during synthesis, as part of the same call that writes the macro moments.
- Compute a deterministic importance score from synthesis artifacts (example: number of micro moments rolled up, number of distinct sources, whether the moment is a root/major branch point).

For demo prep, starting with a deterministic score seems like a fast way to get control over output size, and we can later decide whether to add a model-provided score as an extra signal.

### Update: why query similarity should not be used to filter timeline events
The main reason to use the Moment Graph instead of a standard similarity search is that most events that matter for an answer (early attempts, original problem framing, follow-on work) are often not semantically similar to the user's exact question text. Similarity can find an anchor moment (often close to the solution), but it will not match the rest of the narrative.

Given that, query similarity should stay limited to choosing an anchor (or a small set of anchors). It should not be used to score or filter the expanded timeline, because that would drop the context that is the point of the graph walk.

### Revised direction: intrinsic importance drives thinning, not query similarity
Instead of combining query similarity with importance, the main filter for the expanded timeline should be intrinsic importance.

The remaining question is how to thin a large timeline while keeping it readable. A likely shape:
- Always keep the subject/root moment.
- Always keep the similarity anchor moment (or whichever moment was used to pick the root).
- Keep all moments above an importance threshold.
- Keep a small amount of connective tissue so the output still reads as a sequence (example: include ancestors of kept moments, and include a small number of neighbors around kept moments).

This keeps the graph advantage (contextual stitching) while bounding output size.

### Cursor integration: improve tool bootstrapping + engine-side instructions
There are two separate places where prompting/instructions matter:
- Tool bootstrapping (Cursor): the tool description needs to be prescriptive enough that Cursor calls it reliably.
- Engine response: the query response should include instructions that tell the caller how to use the returned timeline (especially for brief mode).

From reading the current code:
- Cursor tool description is in `src/app/ingestors/cursor/scripts/mcp-server.ts` as the `search_machinen` description string.
- Brief mode output is built by `buildBriefingText` in `src/app/engine/engine.ts`.
- Answer mode uses a prompt embedded in `src/app/engine/engine.ts` (the narrative prompt string).

### Proposed instruction strategy
Define a reusable instruction set and reuse it in two ways:
- Brief mode: include an explicit instruction section in the returned text that tells Cursor how to select the subset of timeline events to mention, and how to cite timestamps and sources.
- Answer mode: add a rule that the answer should select only the events that matter for answering the question, and that it should not try to mention every event when the timeline is long.

This keeps query-time behavior fast (no extra model calls) while pushing the selection/reasoning step to the client-side model that is already being invoked for an answer.

### Migration / backfill considerations for adding importance
If we add an importance field to macro moments, existing data needs a value.

Options:
- Re-sync/rebuild the Moment Graph: simplest conceptually, but may take too long for demo prep.
- One-time deterministic backfill: compute importance from existing stored data (example: number of micro paths rolled up, whether the moment is a root, number of children/branching), then update the moment rows. This avoids LLM calls and should be bounded by a small number of DB scans/updates.
- Lazy migration during query: if importance is missing, compute it on the fly and write it back. This adds writes to the query path and is likely not a good fit for demo performance.

The deterministic backfill path seems like the best trade for demo prep if the data shape supports a cheap calculation.

### Revision: importance must be emitted during synthesis (not heuristics)
I don't think we should compute importance from cheap heuristics (example: number of micro paths). That will drift from what we want the system to surface, and it will likely be hard to tune across sources.

The direction is:
- Macro-moment synthesis emits `importance` (float 0-1) for each macro moment in the same model call that produces the macro moments.
- Query time stays free of per-moment model calls.

This shifts the "what matters" decision into the same step that is already doing synthesis.

### Clarification: Approach A vs B
Both approaches require importance to be present on moments.

The difference is where we pay the cost:
- Approach A: build the full timeline at query time, then prune it in memory.
- Approach B: prune during traversal so we never build the full timeline in memory.

For demo prep, Approach A is simpler to implement and iterate on, and the pruning algorithm can be adjusted without changing traversal logic.

### Migration/backfill decision
Instead of migrating existing moments in place, the current plan is to:
- add importance support in code and storage
- backfill into a fresh Moment Graph namespace
- switch the deployed namespace to the backfilled one

This avoids a one-off migration script for existing data and keeps the query path fast.

### Cursor behavior: reduce repeated tool calls
Observed behavior: the client-side model (Cursor) sometimes calls the tool multiple times in a row.

Direction:
- Update the MCP tool description to prefer a single call.
- Update the brief-mode response text to include explicit instructions: use the returned timeline as the source of truth and do not call the tool again unless the user asks for more context that is not present.

### Timeline size controls (even with importance)
Even after filtering by importance, the output can still be too large. We need hard caps.

Direction:
- Apply a max moments cap for responses.
- When capping, rank candidates by:
  - importance (primary)
  - position bias toward the start and end of the timeline (secondary), to preserve "where we started" and "where we ended"

Rationale: the middle of a long timeline often contains repeated attempts and incremental work. If those moments are low-importance, they should be culled before removing early/late moments.

### Implementation notes (in progress)
- Added an `importance` field on moments and macro moment descriptions.
- Updated macro synthesis to emit IMPORTANCE (0-1) per macro moment and parse it from the response.
- Added a Moment Graph DB migration to store importance on moments.
- Query path now prunes long timelines using:
  - importance thresholding
  - a max-moments cap
  - a secondary bias toward keeping early/late timeline positions
  - small neighbor inclusion around kept events
- Brief-mode output now includes explicit instructions (single-call preference, cite timestamps and sources, select only needed events).
- Timeline output now includes per-event importance values so the caller model can do an extra selection pass when the response is still long.
- Brief-mode output no longer includes the query text to reduce tokens.
- Cursor MCP tool description now instructs single-call usage and discourages repeated tool calls.

## PR: Importance Scoring, Timeline Pruning, and Two-Pass Filtering

### Importance Scoring & Two-Pass Filtering

Previously, Moment Graph queries returned every macro-moment in the timeline, often resulting in thousands of events. This overwhelmed the context window and provided no signal on which events were significant. We needed a way to identify key turning points without relying on query similarity, which fails for narrative arcs where early events (problem framing) are semantically distant from the final question.

We solved this with a **two-pass filtering system**:

1.  **Intrinsic Importance (Synthesis Time):**
    We updated the macro-moment synthesis prompt to emit an `IMPORTANCE` score (0-1 float) for every generated moment. This score is intrinsic to the event itself—capturing how significant a moment is to the project history—rather than being derived from a specific user query. This value is stored in the database and indexed.

2.  **Engine Pruning (Query Time):**
    The narrative query engine now performs a first pass of pruning before returning results. It always preserves the root and query anchor, but filters the rest of the timeline based on the importance score, position bias (favoring the start and end of the timeline) and preserve **connective tissue** (neighbors of kept moments). A hard cap ensures the total size remains within limits (default 200 moments).

3.  **Model Selection (Response Time):**
    The second pass happens at the consumption layer. We expose the `importance=0.xx` score directly in the text output for both Brief Mode and Answer Mode. We then instruct the consuming model (Cursor or the internal LLM) to use these scores as a signal when selecting which events to mention in its final answer. This allows the model to make the final judgment call on relevance while working with a pre-curated, high-quality list of candidates.

### Cursor Interaction Improvements

The client-side model (Cursor) was struggling to use the tool effectively, often calling it repeatedly in a loop or ignoring the timeline data.

We updated the **MCP tool description** to be strictly prescriptive, explicitly instructing the model to call the tool once and then answer using the returned text. Additionally, we added a dedicated **Instructions** section to the Brief Mode output. This guides the model to treat the returned timeline as the sole source of truth, prefer high-importance events (now visible in the line data), and cite timestamps and sources. This closes the loop on the two-pass system, giving the client model both the signal (importance scores) and the policy (instructions) to generate high-quality answers.

### Fix: Subrequest Limits

The narrative query path was occasionally hitting Cloudflare's "Too many API requests" error due to high-fanout database fetches during graph traversal. We refactored `findAncestors` and `findDescendants` to perform batched fetches and in-memory traversal with cycle detection, significantly reducing the number of Durable Object calls per query.

## Follow-up: indexing failures in prod-importance backfill logs

After kicking off a backfill to `2025-12-17-prod-importance`, I looked at `/tmp/out.log` to see whether indexing was clean enough to rely on for the namespace switch.

The logs show that importance emission is working (macro synthesis output includes `IMPORTANCE: 0.xx`), but indexing itself is still hitting multiple failure modes:

### Queue sendBatch message limit (100)
The worker can fail while processing `engine-indexing-queue-prod` messages with an error like:
- `Queue sendBatch failed: batch message count of 135 exceeds limit of 100`

This happens when a single indexing job produces more than 100 chunks and we try to enqueue all chunk-processing messages in one `sendBatch`.

Fix: split chunk-processing queue sends into batches of 100.

### Cursor chunking type error (E.trim)
Some Cursor conversations fail in `splitDocumentIntoChunks` with:
- `TypeError: E.trim is not a function`

This suggests some Cursor event fields are not always strings (prompt/text can be non-string values). The chunker was calling `.trim()` without type checking.

Fix: coerce `prompt` and `text` to strings only when they are strings, otherwise treat them as empty.

### Indexing subrequest limit during micro-moment writes
Some indexing jobs (notably GitHub project documents) still hit:
- `Too many API requests by single worker invocation.`

In the indexing path, micro-moments were being stored one row at a time (`upsertMicroMoment` inside a loop). For large documents this creates a large number of Durable Object database RPC calls in a single invocation.

Fix: batch micro-moment persistence per chunk-batch (delete existing rows for the paths, then insert all rows in one insert). This reduces indexing DO database calls from O(micro moments) to O(chunk batches).

## Decision: micro-moment batch storage as JSON blobs

While backfilling a fresh namespace, indexing started failing with `too many SQL variables` errors. This is the SQLite bound-parameter limit showing up again. The immediate cause is micro-moment persistence: even after reducing the number of DO roundtrips, the batched SQL statements can still bind too many parameters in one statement for large documents (Cursor conversations are a common trigger).

The micro-moment table shape is also not aligned with how we actually use micro-moments today. The engine almost always treats micro-moments as a bulk artifact:
- caching: load micro-moments for a document to decide whether a chunk-batch is already computed
- synthesis: feed a list of micro-moments into macro synthesis
- linking: load micro-moments for a document for correlation

Given that, I think it makes sense to store micro-moments as a small number of JSON blobs, keyed by the chunk-batch hash, rather than one row per micro-moment.

This keeps the write path as "replace one blob for one batch" and avoids the large multi-row insert / large IN-list delete patterns that repeatedly hit SQLite limits.

### Drill-down consideration
I can imagine wanting to drill down from a macro-moment to the underlying micro-moments later. If we want that, I think it will work better as a macro-level snapshot:
- store the relevant micro-moment summaries (and their canonical references) on the macro-moment record itself, as a JSON blob
- treat that as a stable "what this macro-moment was synthesized from" view, rather than re-querying micro-moment storage as a live index

Decision: move micro-moment persistence to per-batch JSON blobs (documentId + batchHash), and treat macro-moment drill-down as a separate, explicit snapshot on macro moments if/when we implement it.

### Follow-up: non-SQL-var fixes to keep
While switching micro-moment storage to batch blobs, there were a couple of other backfill fixes that are still useful and orthogonal:
- Chunk-processing queue sends are batched to respect the 100 message `sendBatch` limit.
- Cursor chunking treats non-string prompt/response fields as empty to avoid `.trim()` type errors.
- Chunk processor retries Vectorize inserts on transient `Network connection lost` failures.

### Follow-up: JSON parsing in DO db results
It looks like `rwsdk/db` uses a Kysely plugin that parses JSON columns on read (for example `processed_chunk_hashes_json`). In a couple of places I still call `JSON.parse` directly on values that may already be parsed (notably micro-moment batch reads, and subject child IDs). Plan is to treat these columns as "unknown", then accept either a string (parse it) or an array/object (use it).

I simplified the micro-moment batch reads and subject child ID reads to assume the DB layer returns parsed arrays and to avoid `JSON.parse`.

### Follow-up: inferred db types from migrations
For modules using `rwsdk/db`, the row shapes are already available from `Database<typeof migrations>`. I removed hand-written row types and switched to aliases derived from the inferred table types.

Pattern: define `SubjectInput = SubjectDatabase["subjects"]` for inserts (strings), and `Subject = Override<SubjectInput, { document_ids: string[] }>` for query results (parsed arrays/objects). Cast query results directly: `executeTakeFirst() as unknown as Subject | undefined`.

Removed all `JSON.parse` calls from DB read paths since the Kysely plugin parses JSON automatically. Still use `JSON.stringify` for writes.

## Updated PR: Demo Readiness - Importance Scoring, Timeline Pruning, and Scalable Storage

### Importance Scoring & Two-Pass Filtering

Previously, Moment Graph queries returned every macro-moment in the timeline, often resulting in thousands of events. This overwhelmed the context window and provided no signal on which events were significant.

We solved this with a **two-pass filtering system**:

1.  **Intrinsic Importance (Synthesis Time):**
    We updated the macro-moment synthesis prompt to emit an `IMPORTANCE` score (0-1 float) for every generated moment. This score is intrinsic to the event itself and stored in the database.

2.  **Engine Pruning (Query Time):**
    The narrative query engine now performs a first pass of pruning. It always preserves the root and query anchor, but filters the rest of the timeline based on the importance score, position bias (favoring start/end), and connective tissue (neighbors).

3.  **Model Selection (Response Time):**
    The second pass happens at the consumption layer. We expose the `importance=0.xx` score directly in the text output. We then instruct the consuming model (Cursor) to use these scores as a signal when selecting which events to mention.

### Scalable Storage & Indexing Reliability

During backfills, we encountered scalability cliffs where large documents (e.g., long Cursor conversations) triggered Cloudflare subrequest limits and SQLite bound-parameter limits.

We implemented a major storage refactor and reliability hardening:

*   **JSON Blob Storage for Micro-Moments**: We moved micro-moment persistence from individual rows to per-batch JSON blobs. This aligns storage with our read patterns (caching/synthesis) and drastically reduces the number of database operations and variable bindings per document.
*   **Queue Batching**: Chunk-processing queue sends are now strictly chunked to respect the 100-message `sendBatch` limit.
*   **Robust Ingestion**: We added type safety checks for Cursor ingest payloads to handle non-string fields gracefully, and implemented retries for transient network failures during Vectorize operations.

### Cursor Interaction Improvements

We updated the **MCP tool description** to be strictly prescriptive, instructing the model to call the tool once and then answer using the returned text. We also added a dedicated **Instructions** section to the Brief Mode output to guide the model's summarization behavior.

### Debugging: log query candidate subjects/moments (opt-in)

While testing query output, I saw cases where the narrative path picks a semantically plausible subject (for example a Discord thread) but returns a short timeline that does not include the other sources I expected. The query handler currently short-circuits if any subject match is returned, so understanding the subject candidate list and scores is useful.

I added an opt-in debug log controlled by `MOMENT_GRAPH_DEBUG_QUERY_CANDIDATES`. When enabled, `findSimilarSubjects` and `findSimilarMoments` will log the top candidates from Vectorize including their ids, scores, namespace match, and (when present) the moment row's document id and parent id.

Update: switched this to always-on for debugging. The candidate logs now always emit during `findSimilarSubjects` and `findSimilarMoments` calls. We can remove or re-guard this once query selection is behaving as expected.

2025-12-18 12:57:40 +0200

### Query root selection: use moment similarity, then resolve root

During a test query about caching/prefetching, the candidate logs showed that the top semantic matches were non-root moments (mostly Cursor conversation moments). The query path was calling a subject search first and filtering to root moments, which dropped those candidates. The result was that the query picked a different root that happened to be in the topK and was a root (a Discord day), producing a short timeline that did not include the other sources.

Direction: query should use moment similarity only, pick the best match moment, walk up to resolve the root subject, and then walk down to fetch the full descendant timeline under that root.

2025-12-18 13:01:12 +0200

### Implemented: moment-only query root selection

I removed the subject-first branch from the narrative query handler. The query now:

- queries the moment index for matches
- picks the highest-scoring match
- walks ancestors to resolve the root
- walks descendants from that root to build the timeline

I also trimmed moment candidate logging to the first 10 results to keep per-request logs smaller.

2025-12-18 13:10:23 +0200

### Cursor attribution: derive user handle for chunk authors

In Cursor conversations, the chunk metadata author was always set to "User", which led micro-moment summaries and macro-moment timelines to attribute statements to "User" instead of a stable handle.

I updated the cursor plugin to infer a user handle from the conversation JSON (prefer the email local-part, otherwise fall back to the workspace roots or file paths). The derived handle is used as the author for user prompt chunks.

## PR: Fix Narrative Query Selection and Cursor Attribution

### Fix: Narrative Query Root Selection

Previously, the narrative query logic prioritized searching for "Subjects" (root nodes) before "Moments". This behavior frequently filtered out high-relevance matches that occurred deep within a document (non-root nodes), causing the engine to select inferior root-level matches (e.g., broad Discord threads) instead.

We removed the subject-first search path. The query engine now:
1. Searches the `MOMENT_INDEX` for the best semantic match, regardless of graph position.
2. Resolves the root Subject by walking ancestors.
3. Retrieves the full descendant timeline from that root.

### Improvement: Cursor Author Attribution

Cursor conversation exports lack explicit author handles, defaulting to "User" for human messages. This resulted in generic summaries.

We updated the Cursor plugin to derive a stable user handle from the export metadata, attempting to resolve from:
1. The `user_email` field.
2. Usernames found in `workspace_roots` or file paths.

This derived handle is now used as the chunk author, enabling correct attribution in generated summaries.

2025-12-18 16:14:32 +0200

### Scoping and nested scopes: org-specific routing plugin (idea capture)

Problem: a query can match content from the wrong project because Cursor, GitHub, and Discord documents are currently routed into the same Moment Graph namespace. This makes results look confident but can be from a different context.

Direction: add an organization-specific plugin (hard-coded into the plugin list for this deployment) that decides which Moment Graph namespace to use for both ingestion and query.

Ingestion routing:
- Cursor: infer project from Cursor conversation metadata and file paths (workspace roots, file paths). Use find-up logic over directories when possible.
- GitHub: infer project from repo identity. Route issues, pull requests, and comments for a repo into the corresponding namespace.
- Discord: infer project from channel or thread identity. Route messages in known channels into the corresponding namespace.

Namespace shape:
- Use organization-prefixed namespaces like `redwood:rwsdk`, `redwood:machinen`, `redwood:internal`.
- Nested scopes are acknowledged as the longer-term need (org vs project vs repo), but the short-term implementation routes into a single namespace per project to avoid cross-project mixing.

Query routing:
- Queries need to be routed to a namespace using local context from the MCP client.
- The MCP client should send metadata describing where it is being run (workspace directory or similar).
- The organization-specific plugin uses the query text plus this metadata to select the namespace, using the same inference logic as Cursor ingestion (for example, detect which project the current workspace corresponds to).

Implementation note:
- The proposal is to override the Moment Graph namespace at runtime for the current request, rather than threading a namespace parameter through many call sites.

2025-12-18 16:27:39 +0200

### Implemented: namespace routing plugin (redwood-scope-router)

I added a deployment-specific routing plugin that sets the Moment Graph namespace at runtime for indexing and query.

Current behavior:
- Cursor ingestion: stores workspace roots in Cursor document metadata and uses them to route into `redwood:rwsdk`, `redwood:machinen`, or `redwood:internal`.
- GitHub ingestion: routes based on owner/repo.
- Discord ingestion: routes based on channel id (with a small hard-coded allowlist).
- Query: the MCP client forwards `cwd` and `workspaceRoots`, and query requests are routed using the same path heuristics.

I added an internal flag to mark explicit namespaces so backfills and manual queries that pass a namespace keep working.

2025-12-18 16:53:24 +0200

### Added logging: scope router routing decisions

To validate routing in logs, I added always-on logs in the scope router plugin for both indexing and query. The logs include the selected namespace, inferred project, and small metadata samples (repo/channel ids, workspace roots sample) to keep log volume bounded.

2025-12-18 17:22:10 +0200

### Add namespace prefix for demo dataset isolation

I added support for `MOMENT_GRAPH_NAMESPACE_PREFIX` as an optional environment variable. When set, the engine prepends this prefix when assigning the Moment Graph namespace during:

- Indexing (after the scoping plugin computes the base namespace)
- Query (after the scoping plugin computes the base namespace)
- Explicit namespace overrides passed to `/query`, `/admin/backfill`, and `/admin/resync`
- Indexing queue messages that pass `momentGraphNamespace`

This keeps the routing logic the same (for example `redwood:rwsdk`), but allows running a scoped dataset (for example `demo:redwood:rwsdk`) without changing client code or hard-coding a demo namespace.
