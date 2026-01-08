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
  - The backfill scheduler fetches the issues list from `/repos/<owner>/<repo>/issues` and enqueues each entry as entity_type `issue`. GitHub's issues list includes pull requests, so PRs can enter the issue processing path during backfills unless filtered.
  - Once a PR enters the issue processing path, the issue processor writes it to `github/<owner>/<repo>/issues/<n>/latest.json`, which locks in the document type for later indexing.

- Follow-up on 'documentation updates' appearing in the tree.
  - The 'Discussion on automated documentation updates' node is not a cross-document attachment. It is a second macro moment synthesized from the same GitHub issue document (#804) and chained under the issue's first macro moment.
  - The issue document itself attached to the root due to the first macro moment (client navigation) scoring above threshold and passing the LLM veto step. The other macros in the same stream then appear as descendants even if they are off-topic relative to the root.

- Inspected the local rclone mirror for redwoodjs/sdk under /Users/justin/rw/machinen/.tmp/machinen/github/redwoodjs/sdk.
  - issues/530/latest.json exists and url is https://github.com/redwoodjs/sdk/issues/530.
  - issues/804/latest.json exists and url is https://github.com/redwoodjs/sdk/issues/804. There is no pull-requests/804/latest.json in the mirror.
  - pull-requests coverage in this mirror starts at 812 and goes up to 961.
  - Some numbers exist in both issues/{id}/latest.json and pull-requests/{id}/latest.json (observed: 812, 871, 875, 878).
    - In these overlaps, the issues/{id} file has url /issues/{id} and state open, while the pull-requests/{id} file has url /pull/{id} and state closed or merged.
    - This suggests PRs can be ingested via the issues path and then become stale, because PR lifecycle events continue updating only the pull-request record.
  - The issue and PR JSON outputs have the same shape in the current format, so misclassification is hard to detect after the fact unless both versions exist.
- Implemented ignore and prevention for GitHub PRs showing up under issues.
  - Backfill scheduler now skips items from the issues list that include a pull_request field.
  - Issue processor now detects when the issue API returns a PR-shaped entity and delegates to the PR processor instead of writing issues/{n}.
  - Indexing now skips github/*/*/issues/{n}/latest.json when the corresponding pull-requests/{n}/latest.json exists, and writes an audit event: indexing:skip-duplicate-github-issue.
