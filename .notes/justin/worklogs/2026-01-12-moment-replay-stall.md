# 2026-01-12-moment-replay-stall

## Noticed replay progress stopped before reaching all items

The moment replay run for the namespace prefix seems to stop partway through (example: 1440 / 1590 replayed items). This matches the earlier symptom where synthesis audit exists for a document, but the moments are not present in the moment graph.

## Hypotheses

- The replay worker processes in batches and needs more resumes to complete.
- The replay worker hit an error and stopped re-enqueueing itself, leaving the run in a partial state.
- A replay item is malformed (example: missing document id) and causes the worker to repeat the same pending item without advancing the cursor.

## Plan

- Add visibility for replay cursor and replay item status counts per run, so I can see whether progress is still moving.
- Make the replay worker mark the run as paused on error and mark the offending replay item, so a stopped run is distinguishable from a slow run.

## Noticed missing audit logs for smart linking during replay

During replay, the worker calls the same plugin hook used by normal indexing to propose a parent for the first macro moment in a stream. However, it was not persisting the proposal audit log onto the replayed moment records.

This means replayed moments can show no parent and provide no recorded reason (example: missing index binding, empty candidate set, timeline fit veto), even though the smart linker was invoked.

## Change: persist smart linker audit on replayed moments

I updated the replay worker to attach the proposal audit log to the replayed moment (link audit log field) for macroMomentIndex 0. This should make replayed moment linkage failures inspectable in the audit UI.

## Added UI support to restart replay runs

Replay can stop partway through, and replayed moments can have missing links until the replay reaches them. I added a UI control to restart replay for a run from the beginning.

The restart operation:

- resets the replay cursor for the run
- sets replayed item count back to 0
- marks all replay items back to pending
- clears per-document replay stream state
- re-enqueues the replay job
