## Work Log: Iteration 1 - Smart Linker (Cursor Cross-Document)

**Date:** 2025-12-12

### Problem

The current Moment Graph implementation delivers narrative answers within a single document. The next planned work (Smart Linker, Truth Seeker, more data sources) has a sequencing problem:

- Adding data sources without linking does not validate cross-document narrative stitching.
- Building linking before adding data sources can feel hard to validate, because there is not enough cross-document data to exercise it.

Each iteration should have a deliverable that can be validated with a repeatable fixture, and should still be useful if work stops after that iteration.

### Context

The Bicycle iteration work established:

- Micro-moments ingestion and caching
- Macro-moment synthesis
- Subject-first querying, where root macro-moments are indexed as subjects

The next work should validate cross-document narrative stitching, but without depending on GitHub/Discord ingestion to exist first.

### Decision: Validate cross-document linking using Cursor-only data

Use multiple Cursor conversations (multiple documents) as the stand-in for "multiple sources".

This keeps the surface area small:

- There is already a working ingestion and query path for Cursor.
- I can create several Cursor documents that are intentionally related but separated, then re-ingest them repeatedly to validate behavior.

This avoids waiting for GitHub/Discord ingestion while still testing the cross-document linker in a way that is representative of the eventual system.

### Iteration 1 Scope

**Goal:** Smart Linker that attaches a document's subject to an existing subject when similarity is above a threshold, using Cursor documents only.

**Link target level:** Subject-level (root macro-moment).

**Outcome model:** Merge into an existing subject (one subject timeline spans multiple documents).

**Non-goals (deferred):**

- Explicit correlation hints (Truth Seeker)
- Drill-down to evidence chunks
- GitHub/Discord ingestion
- General cross-source normalization

### Validation Strategy

#### Fixtures

Create two Cursor documents, re-usable across runs:

- Document A: earlier conversation in a workstream (problem discovery, early attempts, partial conclusions).
- Document B: later conversation in the same workstream (implementation decisions, follow-up fixes).

The specific topic/examples can be selected later. The fixture constraint is that A and B are related but do not share many exact phrases, so semantic similarity is required.

Optionally add a third Cursor document to test negative cases:

- Document C: unrelated topic (should not merge into the A/B subject).

#### Acceptance checks

- **Ingestion behavior**:
  - After ingesting A then B, B should attach under A's subject if similarity is above the threshold.
  - Re-ingesting A and B should be stable (no repeated merging artifacts and no unbounded growth).
- **Query behavior**:
  - A narrative query about the barrel files change should return a timeline that includes both:
    - the earlier tree-shaking context (from A)
    - the later barrel files work (from B)
  - A narrative query about the unrelated topic (C) should not pull in A/B.

#### What I can demo after Iteration 1

- A single subject timeline that spans multiple Cursor documents, with a narrative answer that includes the causal context that previously lived in a separate document.

### Notes / Open questions

- Thresholding details and tie-breaking should be tuned against the A/B/C fixtures, not guessed up-front.
- If subject merging turns out to be too destructive for future work, the alternative is to keep subjects separate but create explicit edges between subjects. That is out of scope for this iteration and can be revisited after there is a working merge-based baseline.


