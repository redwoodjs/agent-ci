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

## Validation notes
- Re-indexed the Discord thread in `prod-2025-12-19-17-30:redwood:rwsdk` after indexing issue 552.
- Smart-linker still returned no candidates for the Discord thread and created a new root moment (macro 0 had `parentId: null`, macro 1 chained under it).
- The smart-linker query log now shows `macroMomentIndex: 0` for the Discord thread, which is consistent with anchoring on the first selected macro moment.

## Follow-up validation (second run)
- Re-indexed issue 552, the Discord thread, and PR 933 again in `prod-2025-12-19-17-30:redwood:rwsdk`.
- Vectorize did return matches (not an empty result mode) for both 552 and the Discord thread.
- Discord thread did attach under issue 552 with score 0.811 (auto-high-confidence).
- Issue 552 attached under PR 933 with score 0.864 (auto-high-confidence) because self-matches are rejected as same-document, and PR 933 was the next highest scoring candidate.
- PR 933 attached under issue 552 with score 0.837 (auto-high-confidence).
- The 552 <-> 933 mutual attachment suggests we need a cycle guard (or a policy that prevents reparenting a moment to one of its descendants) before treating this as stable behavior.
