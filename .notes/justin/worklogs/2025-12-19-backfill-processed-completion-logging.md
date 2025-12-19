## Problem

Backfill logs do not make it obvious whether a given processor job is running because of a backfill run, and if so, which namespace prefix was active at the time.

Backfill state also marks completion at the point where work is enqueued (scheduler finished), but I need a log line for when the backfill run has actually been processed (processor jobs drained).

## Context

- GitHub and Discord backfills enqueue scheduler jobs, which enqueue processor jobs.
- The current backfill state tracks cursors and a coarse status.
- We need a run identifier to tie together scheduler logs, processor logs, and the namespace prefix used.
- We need a completion signal that reflects processing, not just enqueueing.

## Plan

- Add a backfill run id to scheduler and processor messages.
- Extend backfill state (DO sqlite) with enqueue/processed counters and completion flags.
- Log per-job fields: run id, event type, namespace prefix.
- Log once when enqueue is done, and once when processed count reaches enqueued count.

## Work log

### 2025-12-19

- Noted that query failures under `prod-2025-12-19-14-06` were explained by empty Vectorize candidates for that namespace, and backfill logs did not show that prefix being populated.
- Started implementing backfill run tracking so logs can show (a) whether a job is from backfill, (b) which prefix was captured for the run, and (c) when processor jobs have drained for that run.
- Added run tracking columns to GitHub + Discord backfill state durable object schemas:
  - current run id
  - captured namespace prefix
  - enqueued count / processed count
  - enqueue completed flag / processed completed flag
  - processed completed timestamp
- Added `backfill_run_id` to scheduler and processor queue messages, and started the run in the backfill HTTP handlers.
- Scheduler increments `enqueued_count` while sending processor messages and logs when enqueueing has finished for the run.
- Processor increments `processed_count` on successful processing and logs once when `processed_count >= enqueued_count` and enqueueing has completed.
- Adjusted GitHub projects backfill processor messages to keep `repository_key` aligned with the backfill state key so processed counts match enqueued counts.
- Checked local log captures (`out.log`, `backfill.log`, and the running `pnpm dev:log` terminal output) for the run tracking markers (`[backfill] started`, `[backfill] enqueue completed`, `[backfill] processed completed`, `backfill_run_id`).
  - No matches found.
  - This looks like the captured logs were from query/indexing paths, not from ingestor backfill routes/scheduler/processor execution.
