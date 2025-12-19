## Problem

We saw a false-positive attachment where a Cursor conversation about SSR bridge / RSC / SSR architecture attached under GitHub PR 933 with `auto-high-confidence`.

From `out.log`, the smart-linker matched a PR 933 macro moment with score ~0.762 and attached immediately because `DEFAULT_SMART_LINKER_THRESHOLD` is 0.75. There is no additional gate for cross-source or cross-topic cases.

Separately, we saw a cycle between issue 552 and PR 933 (each became the other's parent). The cycle makes query-time root resolution unstable, which amplifies the impact of any incorrect attachments because the query ends up anchored on an arbitrary node inside the cycle.

## Constraints / goals

- Keep linking focused on a specific problem, not a broad area.
- Avoid cross-topic false positives even when embeddings are superficially similar (e.g. shared terms like worker/SSR/deploy).
- Keep LLM usage bounded and predictable.
- Preserve the ability for Discord discussion to attach to issue 552.

## Current hypothesis

Vector similarity alone is not a safe attachment decision, especially across heterogeneous sources (GitHub, Discord, Cursor). Using a single vector threshold to form a candidate set, followed by an LLM selection step that evaluates whether the pair is about the same specific problem, should reduce these false positives.

Macro synthesis also currently produces low-signal macro moments (e.g. automated deployment status comments). Those moments become candidates in vector search and can attract unrelated attachments.

## Plan

- Adjust smart-linker to separate:
  - candidate generation: vector top-K with a single score threshold
  - attachment decision: LLM picks the best candidate (or rejects all) based on "same specific problem"
- Make LLM operate over the top N candidates that pass the score threshold, to avoid additional LLM calls per candidate.
- Tighten the LLM rubric to focus on "same specific problem" rather than a shared topic area.
- Update macro synthesis prompt(s) to downrank or exclude automated status-only messages (deploy previews, bot status updates), so they don't produce high-importance macro moments.
- Add cycle prevention at attachment time (reject an attachment if it would create a cycle).

## Notes from logs

- The SSR bridge Cursor conversation attached under PR 933 via `auto-high-confidence` with score 0.7622331.
- The query candidates show issue 552 has parentId=PR 933 and PR 933 has parentId=issue 552, forming a 2-node cycle.

## Proposed shape of the change

- Use a single vector threshold (0.75) only to form a candidate set.
- For candidates that pass the vector threshold (and excluding same-document matches), ask the LLM once to choose among the top N candidates.
- LLM returns a float score (0..1) for the best candidate, where the score represents "same specific problem" (not shared area).
- Attach only if the LLM score is >= 0.75, otherwise no attachment.

This replaces the current behavior where a vector score >= 0.75 attaches without LLM.

## Next tasks (for approval)

- Update smart-linker to:
  - gather vector candidates (top K)
  - filter by in-namespace and score >= 0.75
  - filter out same-document candidates
  - send top N to LLM in a single call, asking it to pick the best candidate or reject all
  - attach only if LLM score >= 0.75
  - add structured logs with the vector candidates considered and the LLM selected candidate

- Add cycle prevention in the moment graph attachment path:
  - when selecting parent P for child C, reject if P is already in C's descendant set (or C is in P's ancestor set)

- Reduce macro noise from automated messages:
  - adjust macro synthesis prompt instructions for GitHub PRs/issues to treat deployment status and bot messages as low-signal
  - ensure low-signal macro moments are not upserted into vector indexes (or are forced to very low importance so they fail existing pruning)

- Validation loop:
  - resync the demo keys (552, 933, the Discord thread, the relevant Cursor convs)
  - confirm:
    - Discord thread still attaches under 552
    - Cursor SSR bridge conversation does not attach under 933
    - no 552 <-> 933 cycle can form

## Progress

- Implemented smart-linker shortlist gate:
  - Removed the vector-score-based auto-attach path.
  - Candidates are now short-listed only when score >= 0.75.
  - The top N candidates are sent to the LLM in a single call, which returns a selected id and score.
  - Attachment happens only when the selected candidate is in the shortlist and the LLM score >= 0.75.

- Implemented attachment cycle prevention:
  - On write of a parent id, walk the proposed parent's ancestor chain and reject the write if it would introduce a cycle.

- Reduced macro noise impact on vector search:
  - GitHub micro summarization and macro synthesis prompt contexts now treat automated status updates as low-signal.
  - Vector upserts are skipped when a macro moment importance is below 0.4 (still stored in the moment graph DB).

- Switched smart-linker from LLM selection to an LLM veto:
  - Auto-attach is restored for vector score >= 0.8.
  - For vector score >= 0.75 and < 0.8, smart-linker calls the LLM with a yes/no prompt: return NO only when the attachment is clearly wrong.
  - The LLM veto is attempted for up to 3 candidates, in vector-score order.
