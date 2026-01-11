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

Fix replay continuation and subjects audit loading after subject moments change

### PR description

**Previous state**

After the subject moments and evidence-based linking changes shipped, a couple of follow-up issues showed up in the rollout.

Moment replay runs could appear finished with collection while replay stayed at 0 until a manual resume. Separately, the knowledge graph audit page could stay on "Loading subjects..." for a long time. Some UI copy still used "Root Subjects" even though the model is subject marking, not "no parent".

**Change**

Adjusted replay progress accounting so collection always advances the run counters, including for documents that do not produce chunks, allowing the run to transition into replay without manual intervention.

Simplified the subject list load path in the audit page so it does not do expensive graph-wide aggregation during the initial render, and updated labels to use "Subjects" / "Subject Tree".

**Outcomes**

- Replay runs can continue from collection into replay without requiring a manual resume.
- The audit page subject list returns quickly instead of appearing stuck on loading.
- Audit UI copy matches the subject-marking model.

**Testing**

- pnpm build
