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
  - Logs show smart-linker rejecting candidate parents due to a temporal-order check that treats a parent ending after a child starts as invalid, which blocks otherwise reasonable attachments.
  - Query-time behavior should stay as: pick the single chosen match, resolve its root ancestor, then include all descendants from that root before pruning.

- Follow-up after backfill into a single namespace: smart-linker returned zero candidates (empty SUBJECT_INDEX query), so PR and Discord stayed as separate roots and the query timeline only contained issue 552.
  - Suspected Vectorize metadata indexing: namespace filtering depends on momentGraphNamespace being indexed as a Vectorize metadata index.
  - Updated wrangler config to use fresh Vectorize indexes for subject and moment.
  - Updated engine README to include wrangler commands for creating Vectorize metadata indexes on momentGraphNamespace for both moment and subject indexes.
  - Added a smart-linker fallback: if SUBJECT_INDEX query returns zero matches, rerun the same vector query against MOMENT_INDEX (still filtered by momentGraphNamespace).

## PR description (appended)

## PR title

Smart linker attachment, Vectorize namespace filtering, and narrative anchoring

## Context

The indexing and query path depends on the Moment Graph namespace being consistent across:
- document routing
- vector upserts
- vector queries
- narrative timeline assembly

In this branch, a few issues showed up together:
- Smart linker was using document micro-moment concatenation as the vector query text, which did not match the embedding input used for subjects.
- Smart linker rejected some candidate parents due to a temporal check that treated overlapping time ranges as invalid.
- Discord threads could route to a different namespace than the GitHub work item they should attach under.
- Vectorize metadata filtering can return empty results unless the filter field is indexed.
- The narrative query fast-path could anchor on the matched moment instead of the root subject, which dropped related descendants.

## Smart linker macro query text and thresholds

- Use the candidate macro moment summary (fallback to title) as the vector query text when proposing a parent.
- Update thresholds:
  - auto-accept: 0.85
  - LLM gate lower bound: 0.6
- Use reasoning effort high for the smart-linker classifier.

## Storage-time attachment filtering and fallback

- Change the temporal ordering check to reject only when the candidate parent starts after the child starts.
- Keep a note when the candidate parent ends after the child starts.
- If a SUBJECT_INDEX query returns zero matches, retry the same query against MOMENT_INDEX (still filtered by momentGraphNamespace).

## Query-time narrative anchoring

- When a GitHub work item or Discord thread is present in the top matches, anchor on the selected candidate.
- Resolve its root ancestor before walking descendants.
- Prune after assembling the full descendant timeline under that root.

## Namespace routing and Vectorize metadata indexing

- Route Discord channel `1435702216315899948` to `redwood:rwsdk`.
- Rotate Vectorize index names in `wrangler.jsonc`.
- Document the Vectorize metadata index requirement for momentGraphNamespace filtering in `src/app/engine/README.md`.

## Testing

- `pnpm types`: fails (pre-existing errors)
  - `src/app/engine/utils/summarize.ts`: invalid LLM alias
  - `src/app/ingestors/discord/services/gateway-service.ts`: unknown json type
  - `src/app/ingestors/github/services/*-processor.ts`: string | null assignability
  - `src/app/pages/audit/subpages/indexing-table.tsx`: string | undefined assignability
  - `src/db/index.ts`: missing Env.DATABASE
  - `wsproxy/proxy.ts`: Bun types and implicit any params