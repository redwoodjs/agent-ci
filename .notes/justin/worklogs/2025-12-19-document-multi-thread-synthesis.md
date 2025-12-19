## Problem

Discord channel and channel-day documents include many unrelated topics. If any part of that document attaches under a subject (example: a GitHub issue), the query timeline pulls in the document's entire macro timeline, which effectively drags an entire channel's activity into an unrelated tree.

This is not a Discord-only problem. PRs and Cursor conversations can also cover multiple topics. The difference is that they often have a stronger central theme, so the failure mode shows up less often. The underlying issue is the same: a document's macro moments are not guaranteed to be a single coherent subject.

## Rationale

The current storage model treats a document as a single timeline:

- micro moments are summarized batch-by-batch
- macro synthesis runs over the micro moment stream
- smart-linker proposes a single parent for the document
- the document's macro moments are persisted as one chain under that parent (or as a new root)

That implies: if one macro moment in the document is relevant to a subject, then all macro moments in the document are relevant to that same subject.

For Discord channels (and sometimes long Cursor conversations), that assumption is wrong. Only a subset of the document's moments are relevant to any given subject.

## Proposed direction

Instead of synthesizing a single macro timeline per document, the engine should split a document into multiple streams of thought and treat each stream as its own timeline.

High level:

- While processing micro moments, assign each micro moment to a stream id.
- Preserve stream continuity across micro-moment batches (since micro moments are processed in batches).
- After processing the full document, synthesize macro moments per stream.
- For each stream:
  - decide whether it attaches under an existing subject (via smart-linker) or becomes a new root
  - persist its macro moments as a coherent chain for that stream

This changes the unit of correlation from "document" to "stream".

## Constraints

- We still need batching for micro moment processing.
- We need a stable way to carry stream assignments forward as the next batch is processed.
- We should expect some streams to merge or die off over time.

## Work log

### 2025-12-19

- Noted that query timelines can include an entire Discord channel's macro moments when a single part of that channel content is linked into a tree.
- Interpreting this as a design flaw: the engine treats a document's macro moments as a single subject timeline, but in practice only a subset of moments are relevant to a subject.
- Proposed changing macro synthesis to split a document into multiple streams of thought, continue those streams across batches, and then run correlation + storage per stream.

- Implemented multi-stream macro synthesis for Discord channel/day documents:
  - Added an alternate synthesis mode that asks the LLM to output multiple STREAM blocks, each with its own macro-moment sequence.
  - Applied this only when the document source metadata type is "discord-channel".
  - For each stream, ran smart-linker attachment selection and persisted the stream's macro moments as a separate chain.
  - Included the stream id in macro moment source metadata and in indexing logs.
