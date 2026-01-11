# 2026-01-11-find-moments-by-document

## Problem

The user wants to find all relevant moments for a particular document, likely by searching for the document path. There is currently no explicit feature mentioned to view "all moments for a document" in the UI, although the architecture doc suggests a link exists.

## Plan

1.  **Investigation**:
    *   Check `src/app/engine/momentDb` and `src/app/engine/db` to see how moments store document references.
    *   Check if there's an existing API to query moments by document.
    *   Check the UI for existing document search/view capabilities.
2.  **Backend Implementation** (if needed):
    *   Add a query method to fetch moments by document ID/path.
    *   Expose this via an API endpoint.
3.  **Frontend Implementation**:
    *   Add a search interface (or extend existing one) to find a document.
    *   Create a view to display the list of moments associated with that document.

## Context

*   `docs/architecture/knowledge-synthesis-engine.md` mentions moments have a Document ID (R2 key).

## Implementation Details

### Backend
*   Added `getMomentsForDocument` to `src/app/engine/momentDb/index.ts`. This function queries the `moments` table for all moments matching a `document_id`, ordered by creation time.
*   This function is directly imported by the frontend pages (assuming server-side rendering or monolithic deployment).

### Frontend - Ingestion List Page
*   Updated `src/app/pages/audit/subpages/ingestion-list-page.tsx` to include a search filter for "File path".
*   Users can now filter the list of ingestion files by path (prefix/substring match).
*   Pagination and filtering work together.
*   Updated to support passing `namespace` and `prefix` query parameters, which are preserved in links to file detail pages.
*   Added explicit UI inputs (Select for namespace, Input for prefix override) to the Ingestion List Page so users can easily configure these parameters.
*   Implemented a new `Select` component in `src/app/components/ui/select.tsx` using `@radix-ui/react-select` to support the namespace selector.

### Frontend - Ingestion File Page
*   Updated `src/app/pages/audit/subpages/ingestion-file-page.tsx` (the detail page for a document).
*   It now fetches moments for the document using `getMomentsForDocument`.
*   Displays a new "Moments" card below the file content, listing all moments associated with that document, including details like title, summary, importance, and parent ID.
*   Updated to read `namespace` and `prefix` from URL query parameters.
*   It uses `applyMomentGraphNamespacePrefixValue` to correctly resolve the effective namespace (combining environment defaults with overrides) before querying the database.
*   Includes a "Namespace" indicator in the UI if an effective namespace is being used.
*   The "Back" link preserves the `namespace` and `prefix` parameters.
*   Added a "View in Graph" button for each moment in the list. This button (reused from `ViewInGraphButton`) resolves the root ancestor of the moment and redirects the user to the `knowledge-graph` page with the correct `rootId` and `highlightMomentId`. Crucially, it now also passes the `namespace` and `prefix` parameters to the graph view so the correct context is maintained.
