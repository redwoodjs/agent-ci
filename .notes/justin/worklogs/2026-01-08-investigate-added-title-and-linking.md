# 2026-01-08 - Investigate 'Added' title regression and unexpected linking

## Problem

In the knowledge graph UI for prefix prod-2025-01-08-12-58 under redwood:rwsdk, a moment appears with a title like 'Added'. This looks like a regression in source-aware phrasing (issue vs PR vs other document types).

In the same tree, an unrelated moment is connected to the root, while expected related cursor/discord discussions did not connect.

## Plan

- Use the knowledge graph UI to identify:
  - the moment id for the 'Added' node
  - the unrelated connected moment id
- Call the admin moment debug endpoint for those moments with:
  - provenance
  - document audit logs (macro synthesis + gating audit)
  - the root tree and linkage audit logs (candidate scores and reject reasons)
- Use the audit payload to answer:
  - whether the macro synthesis prompt included document type/source context
  - whether gating kept a low-signal macro due to thresholds/heuristics
  - why smart-linker attached an unrelated moment (candidate scoring, tie-breaks, query text)
  - whether expected cursor/discord docs produced macro moments, and if so why they were not attached (candidate set, scores, thresholds)

## Log

- Started investigation.
- Used `/admin/moment-debug` for rootId b3720d17-7a5d-4f74-9ace-4f06c556d9ff in namespace redwood:rwsdk with namespacePrefix prod-2025-01-08-12-58.
  - Root documentId is github/redwoodjs/sdk/issues/530/latest.json.
  - The macro synthesis response includes a title that begins with 'Added' for the issue: '[GitHub Issue #530] Added client-side navigation support for single-page apps'.
  - The synthesis audit records only a prompt hash and a truncated response preview; there is no explicit document-type guidance surfaced there beyond the required title prefix and summary prefix.
  - Gating kept 3 of 4 macros and dropped the Cloudflare Pages bot deployment macro as noise.
- Inspected the root tree returned by the endpoint.
  - Direct children under the root are:
    - Issue #530 macro: 'Requested hook on fetch call for preload functionality'
    - Issue #804: 'Proposed public navigate function for client-side navigation'
    - PR #933: 'Added preloading support for client navigation'
  - No cursor or discord documents appear anywhere in the returned tree for this namespace/prefix.
- Investigated why the other GitHub documents attached under the root.
  - Issue #804 attached to the root with score ~0.774 (threshold 0.75) and was chosen by the LLM veto step (veto YES).
  - PR #933 attached to the root with score ~0.774 (threshold 0.75) and was chosen by the LLM veto step (veto YES). Issue #552 was also shortlisted (~0.755) but not chosen.
  - Issue #605 attached under a deeper Issue #530 macro with a score just over the threshold (~0.7505) and LLM veto YES. This is borderline and sensitive to thresholding.
- Looked at scoping rules for cross-source linking.
  - The redwood scope router can route github, discord, and cursor documents into redwood:rwsdk, but discord routing is currently a channel id allowlist and cursor routing depends on workspace roots path inference.
  - Given that neither the tree nor candidate sets contain non-GitHub documents, it seems likely the expected cursor/discord documents were either not indexed in this prefix run, or were routed to a different namespace (often redwood:internal) and therefore excluded from candidate search.

- Follow-up on the 'Issue vs PR' confusion.
  - The github plugin sets the document type based on the R2 key path segment (issues vs pull-requests), so if a PR is stored under an issues key, it will be treated as an issue during synthesis and labeling.
  - The issue ingestor fetches GitHub entities from the `/issues/<number>` API and does not check whether the returned entity is a PR (GitHub includes PRs in the issues API, with a `pull_request` field).
  - This explains how a PR could be stored under an issues key and then show up as 'GitHub Issue #...' in moments, even if the underlying discussion is about a PR.

- Follow-up on 'documentation updates' appearing in the tree.
  - The 'Discussion on automated documentation updates' node is not a cross-document attachment. It is a second macro moment synthesized from the same GitHub issue document (#804) and chained under the issue's first macro moment.
  - The issue document itself attached to the root due to the first macro moment (client navigation) scoring above threshold and passing the LLM veto step. The other macros in the same stream then appear as descendants even if they are off-topic relative to the root.

- Direction for improving chain attachment decisions.
  - Current behavior is dominated by pairwise semantic similarity (macro summary vs candidate moment/subject) plus a narrow LLM veto step over a small shortlist.
  - A better question seems to be "does this moment fit into this timeline", where the "timeline" is the chain (or local subgraph) under the candidate root, not a single node.
  - This framing could apply in two places:
    - link-time: use chain context to decide whether to attach and where
    - synthesis-time: when a document yields multiple semantic threads, avoid forcing all macros into one chain by selecting a per-thread anchor and attaching each thread independently

- Decision: implement chain-aware linking first.
  - Use the existing vector search shortlist as a candidate generator.
  - Replace the current LLM veto question with a chain-aware question: does the proposed moment fit into the candidate chain's timeline.
  - Keep the context bounded by including:
    - root moment title and summary
    - the last N moments in the chain (title, summary, timestamp)
    - a small set of higher-importance moments
  - Treat this as an attachment gate rather than a full re-parenting system:
    - if no candidate chain accepts the proposed moment, keep it as a root
    - if a chain accepts, attach under the chosen parent as today
  - Defer multi-stream attachment changes until after chain-aware linking is working, since it changes fewer moving parts.

- Implemented chain-aware linking.
  - Added `getChainContextForMoment` in momentDb, which composes:
    - root moment
    - tail moments on the root->candidate path
    - a bounded high-importance sample under the root (excluding the path)
  - Updated smart-linker to replace the pairwise LLM veto with a timeline fit check using the chain context.
  - Added env-configurable caps:
    - `SMART_LINKER_TIMELINE_MAX_TAIL`
    - `SMART_LINKER_TIMELINE_HIGH_IMPORTANCE_CUTOFF`
    - `SMART_LINKER_TIMELINE_MAX_HIGH_IMPORTANCE`
    - `SMART_LINKER_TIMELINE_MAX_DESCENDANT_SCAN_NODES`
    - `SMART_LINKER_TIMELINE_MAX_CONTEXT_CHARS`
  - Extended the linkage audit log to include the timeline context parameters and the timeline fit decision per candidate.
  - Restored missing exports used elsewhere in the worktree (`getDiagnosticInfo` and `getRootAncestorAction`) and ran `npm run build`.

