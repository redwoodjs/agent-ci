# 2026-01-09 - Time-ordered replay using moments instead of documents

## Problem

Backfill and resync runs index documents in an order that is not aligned with the way work unfolded over time. This affects how the Moment Graph is constructed because parent selection depends on what already exists in the graph (and, now, on bounded chain context used by the smart linker).

Sorting documents by a single timestamp is not sufficient because most documents evolve over time:

- GitHub issues and pull requests accumulate comments and edits.
- Discord threads accumulate messages.
- Cursor conversations accumulate messages.

Indexing a document as a single artifact uses the document's most recent state, which leaks "future" context into earlier parts of the timeline.

## Observations

- The engine currently derives macro moment timestamps from micro moment membership, which gives each macro moment a reasonable event time.
- The linking step uses existing stored moments (and their chain context) to decide attachments.
- When documents are indexed out of order, a later chain can exist before an earlier moment is considered, which can skew attachments.
- Even if documents are processed in order of their creation time, the full document state still contains later edits, so the synthesized macro moments can reflect knowledge that would not have existed at the earlier time.
- Timestamp attribution errors are hard to spot without surfacing the timestamp inputs.

## Options

### Option A: Time-ordered document replay

Collect all R2 keys for a run, compute a per-document timestamp, and process in time order.

This helps with coarse ordering but does not solve document evolution because each document is still indexed in its latest form.

### Option B: "De-aging" documents and simulating evolution

Treat each document as an evolving stream and simulate its growth over time:

- split into snapshots (or incremental deltas)
- replay snapshots chronologically

This would be more realistic but seems complex. It also implies changes in ingestion formats and/or storing historical snapshots for each source.

### Option C: Time-ordered replay of moments (not documents)

Change the unit of replay from documents to synthesized macro moments:

- Compute macro moments for each document once (as today).
- Treat each macro moment as an event with its own timestamp.
- Replay macro moments into an initially empty namespace in chronological order:
  - for each macro moment, run parent selection/linking against the current graph state
  - persist it with the chosen parent (or as a root)

This does not fully simulate document evolution, but it avoids forcing an entire document's macro chain into the graph at once. It also ensures that linking decisions only see the "graph so far" according to event time.

## Current leaning

Option C seems like the smallest step that tests the hypothesis:

- that "graph so far" context materially affects linking quality
- and that inserting moments in time order reduces odd attachments caused by out-of-order backfill

Option C still requires decoupling macro synthesis from persistence/linking so we can build a temporary list of macro moments and then replay them into the graph.

## Clarification

- Keep the existing `/admin/backfill` API shape and semantics. This is an implementation change, not an endpoint change.
- No feature flag or runtime switch. If the approach is wrong, revert the change.
- The pipeline still starts from documents and runs chunk -> micro -> macro as today. The fork point is after macro moment generation: collect replayable moments and then replay them in time order.

## Plan

- Define a "moment replay" backfill mode that operates within a namespacePrefix and builds a fresh graph state.
- Specify a data structure for a "replayable macro moment" (title, summary, author, createdAt, documentId, source metadata, stream id, macro index, importance).
- Determine how to handle multiple macro moments from a single document:
  - replay each macro moment independently
  - or replay by stream while still ordering by each macro moment's timestamp
- Define a persistence strategy:
  - store replay inputs in a staging table, then replay into moments table
  - or generate and replay in one pass, with replay progress stored in backfill state
- Identify what should be captured in audit logs to compare behavior between:
  - normal document indexing
  - moment replay indexing
- Add timestamp auditing support:
  - Persist and expose both `createdAt` and the derived `timeRange.start/end` for each persisted moment (when available).
  - Extend the debug endpoint and audit UI to show these timestamps for a selected moment and for nodes in the returned tree.
  - This provides a direct way to spot incorrect timestamp attribution during replay experiments.


## Implementation notes (continued)

- Added replay run and item staging tables to the engine indexing-state Durable Object database, keyed by the effective namespace.
- Backfill now creates a replay run id and enqueues per-document collect jobs when a namespace prefix override is provided. The collect job runs the normal indexing flow, but writes replay items instead of persisting moments.
- When the last collect job finishes, it enqueues a replay job. The replay job reads staged items ordered by event time and persists moments into the graph.
- Replay items are stored as single JSON blobs per macro moment, plus `order_ms` for sorting.

## PR

Title: Moment replay backfill staging and timestamp auditing

Description:

Backfill and resync currently persist moments by document in an order that is not aligned with event time, so parent selection and chain context can reflect later work before earlier work is added.

This change keeps the existing backfill API and changes the implementation to stage macro moments and then replay them in time order:

- Backfill with a namespace prefix override enqueues per-document collect jobs.
- Collect jobs run the normal document pipeline through macro moment generation, but write replay items to a staging table as JSON blobs keyed by run id.
- When collection completes, a replay job reads staged items ordered by derived event time and persists moments into the graph.
- Staging is global (not scoped by namespace) and each staged item records its effective namespace so scoping still follows the existing router behavior.

For auditing timestamp attribution:

- Moment debug tree nodes include `timeRange.start/end` (when present in source metadata).
- The audit UI moment details panel shows createdAt and timeRange.

Testing:

- Deployed to production and started a replay backfill run.
- Observed collect-time errors for some documents (no plugin match for certain Discord jsonl paths, and intermittent network connection lost).
