## Problem
When indexing a document, the engine selects a single macro moment (highest importance) as the smart-linker query input. If that macro moment summary does not retrieve candidates from Vectorize, the document will not attach, even if another macro moment in the same document would have retrieved candidates.

This showed up in `prod-2025-12-19-17-01:redwood:rwsdk` where a Discord thread created a root subject because the chosen anchor macro moment produced no candidates.

## Plan
- Adjust the indexing flow so the smart-linker query uses a concatenation of the document's important macro moments (75th percentile cutoff, with a small cap to limit noise).
- Anchor the attachment semantics (timestamps, macro index recorded in logs) on the first important macro moment.
- Keep the existing smart-linker thresholds and LLM checks unchanged.
- Run typecheck.
- Update architecture docs after the behavior is stable.

## Progress
- Starting implementation.
- Updated macro anchor selection during indexing:
  - Compute p75 cutoff over macro moment importances (per document).
  - Select macro moments at or above the cutoff.
  - Ensure at least 2 macros are used when there are 2+ macros.
  - Cap the concatenated set to 3 macros.
  - Use the first selected macro as the anchor for macro index and timestamps.
  - Concatenate the selected macros (title + summary) into the anchor macro summary so smart-linker queries Vectorize using that combined text.
- Ran `pnpm types`; typecheck fails in existing files unrelated to this change, so it is not a reliable gate for this diff.
- Updated architecture doc to describe the percentile-based macro subset + concatenated query approach.
