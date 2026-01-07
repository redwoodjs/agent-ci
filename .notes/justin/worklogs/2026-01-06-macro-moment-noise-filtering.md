# 2026-01-06 - Macro moment noise filtering

## Problem

Macro moments for Discord channel/day documents sometimes include low-signal chatter (examples: greetings, jokes, “back now”, logistics). This makes moment trees harder to read and makes correlation/linking harder to reason about, because irrelevant macro nodes get promoted into the graph.

Example: a macro moment like “Justin apologized for delay due to car ownership change and returned to the channel” is not a turning point for a work item and should not be persisted as a macro moment.

## Context

- Discord channel/day JSONL documents can contain multiple unrelated threads interleaved in time.
- The engine already synthesizes micro moments and then synthesizes macro moments into multiple “streams”.
- The current issue is not only linking; it is upstream selection of which events are promoted to macro moments.

## Plan (initial)

- Inspect the current synthesis path to confirm where multi-stream synthesis is invoked and where macro moments are persisted.
- Identify what metadata exists to trace macro moments back to source messages (to support debugging).
- Update architecture documentation to describe the intended “macro moment selection” behavior:
  - stricter macro synthesis output constraints
  - importance-based gating (dropping low-importance macro moments)
  - optional cheap pre-filtering of obviously low-signal Discord messages
- After doc update, write a concrete implementation task list and pause for approval before making code changes.

## Findings (investigation)

- The Discord channel/day JSONL format is inherently multi-topic: unrelated tangents (social chat, logistics) can be interleaved with technical discussion in the same document.
- The engine does already attempt multi-stream synthesis. `indexDocument()` calls a multi-stream macro synthesizer and then persists each stream as its own macro-moment chain.
- Macro moments preserve provenance via:
  - document id (R2 key)
  - micro moment membership (`microPaths`)
  - per-macro `sourceMetadata.timeRange` derived from member micro moments
  - per-micro `sourceMetadata.chunkIds` (chunk ids include Discord message ids for channel-day documents)
- Despite multi-stream, the macro synthesizer can still promote low-signal chatter into macro moments. This can happen when:
  - the model treats “notable within the day” as “notable for the work item”
  - the output constraints do not strongly disallow social/administrative events as macro moments

## Decisions (so far)

- Treat “macro moment selection” as a first-class concern, separate from linking/correlation.
- Add explicit constraints to macro synthesis so it emits only work-relevant turning points.
- Add an importance-based gating step after macro synthesis to drop low-importance macro moments before persistence, while keeping provenance available via micro moments and raw documents for debugging.

## Architecture update

- Updated the Knowledge Synthesis Engine architecture doc to describe “macro moment selection” (noise filtering) as a separate concern from threading and correlation.
- Documented a two-layer approach:
  - synthesis prompt constraints to avoid emitting social/administrative chatter as macro moments
  - post-synthesis gating using importance to drop low-signal macro moments before persistence
- Documented provenance needs for debugging macro selection (document id, micro membership, time range, chunk ids).

## Proposed implementation tasks (needs approval before code changes)

- Add macro synthesis prompt constraints for noise avoidance:
  - Update multi-stream synthesis prompt to explicitly exclude social chatter and administrative status updates as macro moments.
  - Prefer emitting fewer macro moments over emitting low-signal macro moments.
- Add post-synthesis gating before persistence:
  - Introduce a deterministic gating rule for macro moments within each stream:
    - keep top N by importance (tie-break by chronological order)
    - optionally keep any moment above a minimum threshold
  - Apply gating before anchoring and before calling the smart linker for correlation.
- Preserve debugging visibility:
  - Expose per-moment provenance in audit UI and/or debug endpoint:
    - stream id
    - microPaths count
    - derived time range
    - a small sample of chunk ids (for Discord, includes message ids)
  - Add a link from a moment to the ingestion file viewer using document id (R2 key).
- Optional cheap Discord pre-filtering (only if prompt + gating is insufficient):
  - Mark or skip clearly low-signal channel messages (emoji-only, gif-only, short reactions) during chunking or micro moment computation.

## Implementation (in progress)

- Tightened the multi-stream macro synthesis prompt to explicitly exclude social chatter and administrative status updates as macro moments, and to allow leaving low-signal indices unused.
- Added a deterministic post-synthesis gating step per stream before persistence:
  - configurable via env:
    - MACRO_MOMENT_MAX_PER_STREAM (default 12)
    - MACRO_MOMENT_MIN_IMPORTANCE (default 0.25)
  - keeps up to max moments by importance, then drops any below the min importance; if that would drop everything, keeps the top candidate as a fallback.

- Added a provenance helper for debugging macro selection:
  - moment debug endpoint can now include a provenance section (stream id, time range, micro paths count, chunk id sample, Discord message id sample, ingestion file path).
  - audit UI moment details now links to the ingestion file and displays stream/time range/message id samples when available.

## PR Title: Macro moment noise filtering and provenance debugging

### Description

Currently, the knowledge graph can become cluttered with "noise" moments—low-signal events like social chatter, administrative updates ("back in 5"), or off-topic tangents that get promoted into the graph. This makes moment trees hard to read and complicates the smart linker's job by providing irrelevant candidates for attachment.

This change implements a two-stage noise reduction strategy:

1.  **Prompt-level Selection**: The macro synthesis prompt now explicitly instructs the LLM to exclude social chatter, jokes, and purely logistical updates, and allows it to omit low-signal micro-moments entirely from the output.
2.  **Importance Gating**: Before persistence, macro moments are now filtered by a deterministic importance gate. We keep the top N moments per stream (default 12) and drop anything below a minimum importance threshold (default 0.25), ensuring only significant turning points enter the graph.

To support debugging "why did this moment exist?" or "where did this come from?", I've also added provenance features:
- The `/admin/moment-debug` endpoint can now return provenance metadata: stream ID, derived time range, and a sample of source message IDs (e.g. Discord message IDs).
- The Knowledge Graph audit UI now displays this provenance in the moment details panel and provides a direct link to inspect the raw ingestion file in the browser.
