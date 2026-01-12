# 2026-01-12-linking-plugin-refactor

## Noticed that explicit issue closure can be dropped before timeline fit

While investigating why PR #933 did not attach under issue #552, I found that issue #552 was present as a candidate but was rejected before the timeline fit step ran. The decision was made by a fixed vector score threshold.

This makes attachment depend on small score differences even when there are explicit anchors like an issue reference in the proposed moment text.

## Plan

- Remove the fixed vector score threshold as an exclusion step for parent selection.
- Keep candidate generation bounded (vector topK and deterministic filters) and keep the timeline fit evaluation bounded to a small number of candidates.
- Keep deterministic preconditions (namespace mismatch, time inversion, missing moment row, same-document).
- Rename the linker plugin so it is clear that the linking decision is the timeline fit evaluation.

## Implemented: remove threshold gate and rename linker plugin

I updated the linker plugin so it no longer drops candidates purely because they are below a fixed vector score threshold.

Instead, it:

- runs deterministic filters (namespace mismatch, same-document, time inversion, missing moment row)
- ranks candidates (explicit issue ref match first, then vector score)
- runs the timeline fit check for a bounded number of candidates

I also renamed the plugin to `timeline-fit-linker` and updated the engine context to use `timelineFitLinkerPlugin`.

I adjusted the audit log so "shortlisted" reflects the ranked candidate set (explicit issue ref first, then vector score), rather than reflecting the initial score-sorted list.

## Follow-up: explicit issue ref attach when timeline fit call fails

On replay, the explicit issue candidate (#552) was correctly shortlisted, but the timeline fit model call failed (null answer) and the linker treated it as a reject.

I updated the linker so an explicit issue reference match attaches deterministically, and I also record timeline fit call errors in the audit log when they occur.

