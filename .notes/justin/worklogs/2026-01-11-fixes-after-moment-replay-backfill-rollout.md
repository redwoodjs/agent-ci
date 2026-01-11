# 2026-01-11 - Fixes and improvements after moment replay backfill rollout

## Replay stalled until manual resume

In a deployed replay run, collection progressed, but replay stayed at 0 for more than 24 hours. Clicking 'resume replay' caused replay to start and replayed_items began increasing. The worker logs show the replay job being received only after the manual resume action.

Replay auto-start is gated on run counters: replay is enqueued only when processed_documents reaches expected_documents and replay_enqueued is still false. If some collect jobs exit early without recording a terminal document result, processed_documents can stay below expected_documents even though collection is effectively done. In that case replay is never auto-enqueued.

Root cause: in indexing-scheduler-worker, after calling indexDocument, the code returns early when newChunks.length === 0. In moment replay collect mode, that early return skipped calling recordReplayDocumentResult for that r2 key, so documents that produced zero chunks were never counted as processed for the run.

Change: in moment replay collect mode, record the per-document result even when indexDocument produces zero chunks, and then run the replay enqueue check after recording so the last collect job can enqueue replay.

Built locally with pnpm build.

