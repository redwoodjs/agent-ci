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


