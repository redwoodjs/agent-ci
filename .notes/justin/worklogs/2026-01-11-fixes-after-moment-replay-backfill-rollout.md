# 2026-01-11 - Fixes after subject moments and evidence-based linking changes

## Replay stalled until manual resume

In a deployed replay run, collection progressed, but replay stayed at 0 for more than 24 hours. Clicking 'resume replay' caused replay to start and replayed_items began increasing. The worker logs show the replay job being received only after the manual resume action.

Replay auto-start is gated on run counters: replay is enqueued only when processed_documents reaches expected_documents and replay_enqueued is still false. If some collect jobs exit early without recording a terminal document result, processed_documents can stay below expected_documents even though collection is effectively done. In that case replay is never auto-enqueued.

Root cause: in indexing-scheduler-worker, after calling indexDocument, the code returns early when newChunks.length === 0. In moment replay collect mode, that early return skipped calling recordReplayDocumentResult for that r2 key, so documents that produced zero chunks were never counted as processed for the run.

Change: in moment replay collect mode, record the per-document result even when indexDocument produces zero chunks, and then run the replay enqueue check after recording so the last collect job can enqueue replay.

Built locally with pnpm build.

## UI wording: root subjects vs subjects

Observed the audit UI still showing copy like "Root Subjects" even though the intended model is to present all subject moments (topic demarcations), not only unparented moments.

Change:
- Updated audit UI labels and helper text to use "Subjects" / "Subject Tree" rather than "Root Subjects" / "Roots".
- This was a presentation change; the list was already sourced from subject-marked moments.

## Audit UI: subjects list stuck loading

Observed the subjects list in the knowledge graph audit UI staying in a loading state.

Looked at deploy logs and saw some RSC action requests taking tens of seconds.

Change:
- Removed descendant counting from the subject list query (it was scanning all moments and walking the graph).
- Updated the UI to tolerate unknown descendant counts (shows descendants=N/A and does not apply the singleton filter unless the count is known).

## PR

### PR title

Fix replay auto-enqueue and audit subjects list after subject moments change

### PR description

**Previous state**

- Moment replay runs could finish collection but not enqueue replay automatically when a collect job produced zero chunks and returned early without recording the per-document result.
- The knowledge graph audit page could stay in "Loading subjects..." for a long time because the subject list query computed descendant counts by scanning all moments and walking the parent graph.
- The audit UI still referred to "Root Subjects" in some places even though the model is subject marking, not "no parent".

**Change**

- In replay collect mode, record the per-document result even when a document produces zero chunks, so processed document counters reach the expected count and replay can be auto-enqueued.
- Removed descendant count computation from the subject list query and updated the UI to handle unknown descendant counts.
- Updated audit UI labels to use "Subjects" / "Subject Tree".

**Testing**

- pnpm build
