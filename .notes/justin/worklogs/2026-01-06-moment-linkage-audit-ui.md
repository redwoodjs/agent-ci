# 2026-01-06 - Moment linkage audit UI

## Context

The moment graph links documents together by attaching the first macro moment of a document under an existing root moment (a Subject). Attachment decisions currently happen in the Smart Linker plugin and are primarily visible via console logs.

The current visualization (Mermaid knowledge graph page) shows which moments are connected, but it does not show why a link was chosen or why other candidates were rejected.

## Problem

We do not have a durable, queryable record of Smart Linker decisions:

- When a document attaches, there is no stored explanation of which candidates were considered and why the chosen parent was selected.
- When a document does not attach, there is no stored explanation of which candidates were considered and why they were rejected.
- The visualization cannot surface these decisions because the information is not present in the moment graph database.

## Plan

- Add a database column on moments to store a linkage audit log (JSON).
- Plumb Smart Linker candidate decision data into that audit log, including title/summary previews for candidates (not just IDs), scores, thresholds, and reject reasons.
- Store the audit log on the first macro moment for the document, and include which macro moment was used as the linking anchor.
- Update the knowledge graph page to let me click a node and see a linkage panel:
  - Attachment status and chosen parent (when present)
  - A ranked list of candidate moments with score, title/summary previews, and reject reasons (namespace mismatch, missing row, same document, below threshold, LLM veto, etc.)

## Log

- Added a `link_audit_log` column to the `moments` table via a migration so linkage audit data can be stored alongside macro moments.
- Extended moment types and moment DB read/write code to include the linkage audit log as a parsed JSON field.
- Changed the Smart Linker parent proposal hook to return a structured audit payload even when no parent is selected, and stored that payload on the first macro moment for the document during indexing.
- Updated the knowledge graph page to support node selection and to display the stored linkage audit log (candidate list with title/summary previews, scores, and reject reasons).
- Ran `npm run types` and saw existing typecheck failures in other parts of the repo; the edited files were not flagged by the compiler output in that run.
- Added an optional namespace prefix override in the knowledge graph page and threaded it through the audit server actions so a demo prefix can be queried without changing worker environment configuration.
- Added a sampled root list mode (based on high-importance sampling) to reduce noise from singleton roots.
- Added semantic search on the knowledge graph page that finds matching moments and jumps to the resolved root tree, highlighting the matched node.
- Fixed a knowledge graph UI failure caused by Redwood server-function RPC payload size limits (32 MiB) by fetching a slim descendant list (capped by a max-nodes setting) and fetching full moment details on demand when a node is selected.

## PR Title: Audit UI for Smart Linker Decisions

### Description

Debugging the knowledge graph's connectivity is difficult because the decision logic for linking moments—why a document attached to a specific parent, or why it failed to attach—is lost in ephemeral logs. We are "flying blind" when trying to improve the Smart Linker's precision.

This change persists the full decision tree of the Smart Linker directly onto the moment record. It captures the list of candidates considered, their similarity scores, and the specific reasons for rejection (e.g., low score, LLM veto, or temporal mismatch).

The Knowledge Graph visualization has been updated to surface this data. Clicking any node now opens a details panel that reveals its linkage history, allowing us to inspect exactly why connections were made or missed. Additionally, a new "Namespace Prefix Override" control allows us to safely inspect backfilled demo data without needing to redeploy the worker configuration.

## PR Title: Knowledge Graph Explorer & Scalability Fixes

### Description

The initial Knowledge Graph visualization proved difficult to use on real datasets: it was overwhelmed by thousands of singleton (unconnected) roots, lacked a way to find specific content, and crashed when trying to load large trees due to RPC payload limits.

This change upgrades the visualization into a scalable explorer:

- **Noise Reduction**: Added a "Top Roots" view that uses importance sampling to surface trees with meaningful activity, filtering out the long tail of empty roots.
- **Semantic Search**: Added a search control that finds moments by meaning (vector search) and jumps directly to the relevant root tree, highlighting the matched node.
- **Scalability**: Replaced the full-tree fetch with a "slim" graph query (id/title/parent only) capped at 5,000 nodes to stay well under the 32MiB RPC limit. Full moment details (including the linkage audit log) are now fetched on-demand when a node is selected.

## Log (Continued)

- Added `/admin/moment-debug` endpoint to return a JSON payload equivalent to the knowledge graph node details view for a given moment id (moment details, resolved root, and stored linkage audit log).
- Extended `/admin/moment-debug` to optionally include the resolved root tree as a slim node list, capped by a max-nodes parameter, to support inspecting unexpected edges without relying on the UI.

## PR Title: Add moment debug endpoint

### Description

When debugging linkage decisions, it helps to capture an exact JSON snapshot of what the knowledge graph UI shows for a specific moment id. Inspecting via the UI is really helpful starting point, but once we find something to improve on, it helps to be able to be able to share this example with AI.

This change adds `POST /admin/moment-debug`, which returns the moment row, resolved root context, and stored linkage audit log for a provided moment id. Optionally, it can include a small set of candidate moment details referenced by the audit log.

## PR Title: Extend moment debug endpoint with root tree

### Description

When diagnosing unexpected edges, it helps to inspect the entire root tree in the same JSON payload as the selected moment’s debug information. Relying on the UI makes it harder to share and review the exact structure that led to a confusing link.

This change extends `POST /admin/moment-debug` with an `includeTree` option that returns the resolved root tree as a slim node list, capped by `treeMaxNodes` and accompanied by a `truncated` flag.

## PR Title: Fix merge conflict markers in routes.ts

### Description

A previous merge introduced conflict markers (`<<<<<<< HEAD`) into `src/app/engine/routes.ts` that were missed during resolution, breaking the worker build.

This change removes the conflict markers while preserving the intended feature (the `includeTree` logic in the debug endpoint handler).
