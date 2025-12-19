## Problem

Smart linker is using a concatenation of the candidate document's micro moments as the vector query when proposing a macro-moment parent. I want macro linking to be based on macro summary vs macro summary (the same text we embed into SUBJECT_INDEX).

I also want to tune thresholds:
- Smart linker auto-accept threshold: 0.75 -> 0.85
- LLM gate threshold (lower bound for LLM check): 0.5 -> 0.6

And I want the LLM classifier call to use reasoning effort high (instead of low).

## Context

- SUBJECT_INDEX embeddings are generated from each subject moment's summary.
- Current smart-linker query text is derived from the candidate document's micro moments (concatenated), not from the candidate macro moment.

## Plan

- Confirm what text is embedded into SUBJECT_INDEX.
- Update smart-linker query text to use the candidate macro moment summary (fallback to title if summary missing).
- Remove micro-moment query construction from smart-linker.
- Adjust thresholds and LLM reasoning effort.
- Run TypeScript typecheck.

## Work log

### 2025-12-19

- Confirmed SUBJECT_INDEX embeddings are computed with getEmbedding(moment.summary).
- Updated smart-linker query embedding input from document micro-moment concat to the candidate macro moment summary (fallback to title), and removed the micro-moment query plumbing.
- Updated thresholds: auto-accept 0.85, LLM gate 0.6.
- Updated LLM call options for the smart-linker classifier: reasoning effort high.

- Confirmed how the anchor macro moment is used during indexing:
  - Pick the macro moment with the highest importance score in the synthesized list.
  - Pass that moment to proposeMacroMomentParent to get a parent for the document's first macro moment.
  - Attach the rest of the document's macro moments as a chain under the first macro moment.

- Found a bug in the narrative query fast-path for GitHub work items / Discord:
  - It was treating the matched moment as the root and only walking descendants from that moment.
  - Updated it to resolve the root ancestor first (via findAncestors) and then walk descendants from the root.

- Follow-up after improved results: still missing a Discord discussion in the timeline output.
  - Logs show the Discord thread was indexed into a different Moment Graph namespace than the one used when querying issue 552.
  - Logs also show smart-linker rejecting candidate parents due to a temporal-order check that treats a parent ending after a child starts as invalid, which blocks otherwise reasonable attachments.
  - At query time, the narrative path builds a timeline from a single root. If a relevant Discord discussion ends up as a separate root, it will not appear unless we merge timelines across roots.
