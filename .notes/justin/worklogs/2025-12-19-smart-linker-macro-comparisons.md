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

## Notes

- Confirmed SUBJECT_INDEX embeddings are computed with getEmbedding(moment.summary).
- Updated smart-linker query embedding input from document micro-moment concat to the candidate macro moment summary (fallback to title), and removed the micro-moment query plumbing.
- Updated thresholds: auto-accept 0.85, LLM gate 0.6.
- Updated LLM call options: reasoning effort high.
