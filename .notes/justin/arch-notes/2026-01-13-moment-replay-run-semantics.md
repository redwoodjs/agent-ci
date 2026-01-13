# Moment replay run semantics

## Problem

Moment replay is used to regenerate moments from previously ingested documents.

In practice:

- replay can run for hours
- replay progress can appear to stall
- a replay run can be restarted and resumed multiple times

The audit UI currently shows basic progress counters, but it does not show whether work is still happening or whether a run has fallen over.

There is also a correctness issue when replay order differs from chronological order. If a run processes A and C first (manual selection) and later processes B, parent selection can produce a different preferred chain:

- earlier: A -> C
- later: A -> B -> C

The system does not currently have a clean way to restitch existing chains after the fact.

## Constraints

- Replay must be able to make forward progress even when a replay worker execution fails or is interrupted.
- The UI should show enough state to answer:
  - is the run still making progress
  - when was the last progress update
  - what item is currently being processed
  - what failed, if anything
- Parent selection should be reproducible when replay is run in chronological order.
- Restarting replay should allow rebuilding parent chains from scratch, without requiring in-place restitching.
- Replay failure handling should avoid tight retry loops when upstream calls fail (rate limiting, transient model failures).
- Replay should have configurable throughput controls so bulk runs can trade off speed vs upstream rate limiting.

## Approach

#### 1) UI-visible instrumentation (so “stuck vs slow vs failed” is answerable)

- **Persist run telemetry** (in the replay DB, not logs):
  - last progress timestamp
  - replay cursor (lastOrderMs/lastItemId)
  - last processed item (item id, document id, effective namespace, order ms)
  - counts: pending/done/failed, plus “consecutive failures”
  - rollups: embedding calls + total ms, timeline-fit calls + total ms, db writes + total ms
- **Render it in the Knowledge Graph replay runs list**.

#### 2) Failure handling and retry shaping (robustness to falling over)

- **Per-item failure**:
  - mark replay item `failed` and store an error payload
- **Run-level failure**:
  - set run status to `paused_on_error` and store “last error”
- **Retry controls**:
  - “Resume” clears paused state and re-enqueues
  - “Retry failed items” sets failed -> pending (optionally with a cap)
- **Backoff/jitter**:
  - when upstream calls fail in a retryable way (rate limiting/timeouts), sleep with backoff and then retry, otherwise pause.

#### 3) Restart semantics: clear replay output so chains can rebuild (A -> B -> C)

- Add a restart mode: **Restart (clear replay output)**:
  - delete moments created by the run (moment ids == replay item ids), in the effective namespaces recorded on the replay items
  - reset replay items to pending, clear stream state, reset cursor
- This is the supported way to handle “we processed out of order earlier”.

#### 4) Replay performance improvements (instrument + apply knobs)

- **Instrument first** (so we know if bottleneck is timeline-fit LLM, embeddings, or DB).
- Then apply knobs:
  - **Timeline-fit effort knob** during replay (env-configurable; default lower than interactive indexing).
  - **Deterministic gates**:
    - if score very low and no anchors -> skip LLM (reject)
    - if score very high and anchors -> skip LLM (attach)
    - keep explicit anchors as fast-path
  - **Concurrency limits** for AI calls (avoid bursts that trigger 429s).
  - Verify candidate cap stays bounded.

### Approval checkpoint

If you approve this plan, I’ll start implementing in this order: **DB schema -> worker failure recording/pause/backoff -> UI visibility/actions -> restart(clear output) -> perf knobs**.

