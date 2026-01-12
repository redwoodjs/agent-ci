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

## Proceeding with implementation based on moment replay run semantics doc

I updated the moment replay run semantics doc to capture a concrete checklist for:

- run telemetry persisted in the replay DB and rendered in the replay runs list (progress timestamp, cursor, last item metadata, counts, rollups)
- per-item failure recording and run-level paused_on_error state
- retry controls (resume, retry failed items) and backoff/jitter for retryable upstream failures
- a restart mode that clears replay output so chronological linking can rebuild A -> B -> C
- replay performance controls (timeline-fit effort knob, deterministic gates, AI concurrency bounds)

I am implementing in this order:

- DB schema changes and replay DB helpers
- replay worker failure/pause/backoff
- audit UI visibility and retry actions
- restart(clear replay output) implementation
- replay performance knobs

## Noticed replay events UI is hard to use for debugging

The replay runs list has a "Load replay events" section, but it is not a good format for sharing or scanning:

- It is spread across expanders and UI chrome.
- It is hard to copy/paste as plain text to share.

Also, the events currently recorded are sparse, and the most useful information when a run stalls is:

- repeated item-level failures and their error messages
- the item id / document id tied to those failures
- whether the worker re-enqueued work

Next change: add a separate audit page to view a replay run log as plain text (by runId), and record item-level failures as replay run events so the log contains actionable data when a run stalls.

## Noticed the replay log still cannot explain long gaps

After adding the replay run log page, I captured a run where:

- lastProgressAt was recent (so it was likely still progressing)
- there was an ~10 minute gap in the event stream
- events mainly showed worker.start + worker.fetched_batch, and occasional worker.enqueued_next

The missing piece is that we were not recording "batch finished" or unexpected worker failures. When a worker dies between fetched_batch and enqueued_next (timeouts, platform limits, unhandled errors), the log looks like it stopped without explaining why.

Next change: record worker.batch_done with timing and cursor metadata, and record worker.unhandled_error when the worker throws unexpectedly, so gaps can be attributed to slow batches vs worker failures.

## Noticed replay throughput is dominated by timeline-fit LLM calls

I checked the replay rollups and saw timeline-fit total time dwarfing embeddings and DB writes.

In the timeline-fit linker, replay was still defaulting to high reasoning effort for the timeline-fit check unless an env var was set. Also, the replay-only low-score cutoff that skips the timeline-fit LLM call was disabled unless an env var was set.

Next change: make replay default to low reasoning effort for timeline-fit, and enable a conservative replay-only low-score/no-anchor cutoff by default so we avoid paying for timeline-fit calls on weak, anchorless candidates during replay.

I set the default replay low-score cutoff to 0.7 (only when there are no shared anchor tokens).

## Noticed audit knowledge graph root list can hit Cloudflare subrequest caps

I hit an error in the knowledge graph audit page while loading the roots list:

- "Too many API requests by single worker invocation."

The root cause was the subject/root list building doing an N+1 style scan:

- query up to N subject moments
- for each subject moment, run a descendant traversal to compute a count

Even with a maxNodes cap per traversal, doing this for hundreds to thousands of roots can exceed the worker's allowed subrequests and makes the page look like it is stuck.

Change: replace per-root traversal counts with a single grouped query that counts direct children per root, so the root list stays within a fixed number of DB queries.

## Idea: bound smart-linker candidate evaluation for replay throughput

For replay throughput, I want predictable, bounded work per macro-moment. The vector query returns a ranked list, but we don't need to evaluate every match.

Change: after vector search, filter out candidates that are chronologically after the current moment (based on the candidate time metadata), then take the first X remaining candidates for DB fetch and scoring.

## Noticed knowledge graph page can hang on 'Loading graph...'

When clicking moments during replay, the knowledge graph page sometimes stays on 'Loading graph...' indefinitely.

The client sets loading state correctly, so this looks like the server action not returning in a reasonable time. The likely source is the descendant traversal used to fetch the graph nodes. The existing traversal does multiple DB queries per level and can run a large number of queries for long chains.

Change: switch the descendant fetch to a recursive CTE query (single DB query) with a maxNodes + 1 limit to detect truncation. Keep an iterative fallback with a depth cap if the recursive query fails.

## Retrying with a smaller, controlled change

The knowledge graph audit page has a 'Recent failures' section that can get large enough that it pushes the rest of the controls out of view, forcing repeated scrolling.

Change: make the 'Recent failures' section collapsible so it can be tucked away while debugging replay and graph loading issues.

## Noticed replay is stuck at item 241 again

Replay appears to stall at a specific item index without clear explanation in the run log. The plan is to reduce log noise (pause replay if possible) and then isolate why the knowledge graph requests aren't returning.

## Added a manual pause for replay runs

I added a manual pause state for replay runs so I can stop the worker from re-enqueueing itself while debugging.

Change:

- add a paused_manual run status
- add a pause action in the audit UI next to resume
- update the replay worker to skip when it sees paused_manual

## Resolved merge conflicts by restoring staged 'ours' versions

While trying to move quickly, I ended up with merge conflicts in the replay/audit files and this work log.

I restored the stage-2 ('ours') versions of the conflicted files to remove conflict markers, keeping the manual pause and audit UI changes intact. The index still needs staging to complete the merge.

## Added replay fast attach mode to skip timeline-fit LLM calls

For the demo timeline, I added a replay-only fast mode that skips building timeline context and skips the timeline-fit LLM call. When enabled, it attaches to the top-1 chronologically valid vector candidate (with a low-score + no-anchors reject guard).

This is gated behind an env flag so the default behavior stays the same.

## Added replay skip-linking mode to remove vector/LLM parent selection

The fast attach mode still runs vector queries per replay document, and logs showed the worker still making timeline-fit LLM calls in some cases.

Change: add a worker-side env flag to skip plugin-based parent selection for the first macro-moment in a stream. This avoids both vector queries and timeline-fit LLM calls in replay, at the cost of leaving more roots unlinked.

## Adjusted replay fast attach to avoid LLM and DB chain reads while still linking

I want to keep linking behavior for the demo while removing the slow steps.

Change: move replay fast attach earlier in the smart linker, selecting top-1 chronologically valid vector match using vector metadata only. This keeps chronology filtering and issue ref preference, but avoids fetching candidate moment rows and avoids timeline-fit LLM calls.

## Removed the sampled subjects view from the knowledge graph page

The knowledge graph page had two subject list views. The sampled view didn't seem to add much value and added another server action + UI state.

Change: remove the sampled view and keep the full subject list ('Found N subjects...').

## Found slow chain-view server actions behind 'Loading graph data'

The wrangler request logs show the knowledge graph page making RSC action calls that can take ~27s while returning 200 OK. That matches the UI getting stuck on 'Loading graph data' without a visible error.

Change: cap the chain-view context chain query with a maxDownHops value so it returns quickly.

## Two-pass replay idea: populate first, link later without deleting moments

I want a mode where replay populates moments without doing cross-document linking, so the demo has usable data even if linking is slow.

Then I want a second pass that replays again with linking enabled, but does not delete or recreate moments just to set links.

This seems doable because moment writes are id-based and `addMoment()` updates existing rows, including `parent_id`.

Operationally:

- first pass: set `MOMENT_REPLAY_SKIP_LINKING=1`, then restart replay (optionally with clear output if I want to wipe partial output)
- second pass: unset `MOMENT_REPLAY_SKIP_LINKING`, then restart replay without clear output so the run recomputes parent selection and updates `parent_id` in-place
