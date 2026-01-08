# Chain-aware moment linking

## Problem

The current parent selection step relies on pairwise similarity between a proposed macro moment and a small set of candidate parents. This can attach a moment into a chain where it is broadly about the same area, but does not actually belong in the same timeline.

This issue becomes more visible when:

- A topic spans a long period, so timestamps do not rule out a link.
- Many documents discuss the same general area, producing high semantic similarity across otherwise unrelated work items.
- A single document contains multiple semantic threads, but only one of those threads is relevant to the chain it attaches into. If all macros from the document are chained under one anchor, off-topic macros appear as descendants.

## Constraints

- Decisions must use data available at indexing time.
- Decisions should be deterministic given the same stored data.
- The system must handle cross-source content (GitHub, Discord, Cursor) within a namespace.
- The model call budget must remain bounded (avoid unbounded context growth as chains get large).

## Approach

Replace the pairwise question "are these two moments related" with a chain-aware question:

- "Does this proposed moment fit into this timeline?"

Timeline context is a compact view of a candidate chain or local subgraph:

- Root moment summary
- A selection of subsequent moments, each with title, summary, and timestamp
- Optional extracted anchors (canonical tokens, issue or pull request numbers, error strings, file paths)

The decision process is:

- Use vector search to shortlist candidate chains as today.
- For each shortlisted chain, run a chain-aware classifier that returns:
  - attach and a suggested insertion point (or parent)
  - reject with a reason
- Prefer attachments supported by hard anchors (shared canonical tokens or explicit cross-links).
- If no chain passes, create a separate root for the proposed thread.

### Interaction with multi-stream synthesis

When macro synthesis yields multiple streams, each stream is treated as a separate proposed thread:

- Select an anchor macro per stream.
- Run the chain-aware linking decision per stream.
- Attach the remaining macros in the stream under that stream's anchor after the stream is placed.

This avoids forcing unrelated macros from the same document into a chain that was selected based on a different stream.

## Functional outcomes

- Attachments use the existing chain context to distinguish "same area" from "same timeline".
- Borderline semantic matches are less likely to attach without supporting anchors.
- Off-topic macros from a multi-thread document are less likely to appear as descendants under an unrelated chain.

