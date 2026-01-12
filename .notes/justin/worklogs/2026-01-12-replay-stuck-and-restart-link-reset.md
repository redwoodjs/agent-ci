# 2026-01-12-replay-stuck-and-restart-link-reset

## Noticed replay progress appears to stall

After multiple restart/resume attempts, replay was still far from completion hours later (example: ~875 items). It was unclear whether the run was still progressing slowly or whether it had fallen over.

The current UI shows counts, but it does not show:

- whether the replay worker is actively making progress on the run
- how recently progress was made
- whether the worker hit an error, and if so which replay item caused it

## Plan

- Add replay run visibility in the audit UI for:
  - last progress timestamp
  - current replay cursor
  - last processed item id and its document id / effective namespace
  - run status transitions (replaying, paused_on_error, completed)
- Make replay resilient to it falling over:
  - ensure cursor and item statuses are advanced as work is committed (not only at end-of-batch)
  - record a run error state when a replay item fails so the UI can show it
  - avoid tight retry loops by applying backoff and pausing after repeated failures
- Revisit replay performance:
  - measure whether bottleneck is timeline-fit calls, embedding calls, or database writes
  - test lowering timeline-fit reasoning effort and/or reducing per-moment candidate evaluation while preserving explicit anchor handling

## Noticed restart replay should support link reset semantics

If replay processes documents out of order (manual selection) and later processes missing intermediate moments, the best parent chain can change. For example:

- earlier: A -> C
- later: A -> B -> C

I do not want to support inserting a moment into an already-linked chain after the fact.

Instead, restarting replay for a run should have an option to clear any previously persisted replayed moments/links for that run so that chronological replay can rebuild the chain from scratch.

## Revised plan: include UI-visible instrumentation and replay performance changes

I want to implement:

- UI-visible instrumentation so I can tell whether replay is progressing, slow, or stopped.
- Failure handling that records the failing replay item and pauses the run, rather than relying on invisible retries.
- Replay performance changes (bounded) to reduce model and embedding load while preserving explicit anchors.
- Restart semantics that can clear replay output so chronological replay can rebuild chains (A -> B -> C) after out-of-order manual runs.


## Implemented replay telemetry, pause-on-error, and clear-output restart

I changed the replay DB schema to persist:

- last progress timestamp and last item metadata
- per-run counters for embeddings, timeline-fit checks, and moment writes
- per-item failure payloads and failed status

I updated the replay worker to:

- write progress telemetry incrementally as each item is committed
- pause the run on failures and record the error on the replay item
- retry retryable upstream failures with backoff/jitter before pausing

I updated the audit UI to show telemetry in the replay runs list and added controls for:

- resume (clears paused_on_error)
- retry failed items
- restart (clear output) so chronological replay can rebuild links from scratch

## Added run-by-id refresh and clearer error display in UI

I noticed that the replay runs list was refreshed via the prefix list, and the error display assumed the run error payload was an object with a message field.

I changed the UI to:

- fall back to showing the error payload when it is a string
- refresh a replay run by id after restart(clear output), so counter/cursor updates are visible immediately
