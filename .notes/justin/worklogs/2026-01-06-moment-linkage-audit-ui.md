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

## PR Title: Audit UI for Smart Linker Decisions & Graph Explorer

### Description

Debugging the knowledge graph is difficult because linkage decisions are ephemeral and the graph itself is noisy and hard to navigate. We were "flying blind" on why documents connected (or didn't), and often couldn't find relevant subtrees in the visualization.

This change persists the full decision tree of the Smart Linker (candidates, scores, reject reasons) onto the moment record. It also significantly upgrades the Knowledge Graph visualization to be a scalable explorer.

**Key Changes:**
- **Linkage Audit Trail**: Every moment now stores why it attached (or why it rejected candidates), and this is surfaced in a new details panel when clicking a node.
- **Noise Reduction**: Added a "Top Roots" view driven by importance sampling to surface meaningful trees instead of thousands of singletons.
- **Semantic Search**: Added a vector-search control to find moments by meaning and jump directly to their root tree, highlighting the match.
- **Scalability**: Switched the graph fetch to a "slim" format (capped at 5k nodes) with on-demand detail fetching, preventing 32MiB RPC payload crashes on large trees.
- **Demo Support**: Added a "Namespace Prefix Override" to safely inspect backfilled data without redeploying the worker.
