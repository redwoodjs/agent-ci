# Resolve Moment Graph Discrepancy 2026-01-22

## Investigated the discrepancy between Simulation View and Knowledge Graph
###
We found that the Knowledge Graph was filtering for "Root Moments" (parent_id is null) in its primary view, which accounted for the discrepancy (13 roots vs 41 total moments). We also noticed that "Subject Moments" were being filtered separately.

### Plan
- Remove the stale "Root Moments" concept.
- Implement an "All Moments" view (flat list).
- Keep the "Subjects" view focused on the `is_subject` flag.
- Add diagnostic tools to verify database contents.

### Tasks
- [ ] Expose `getDiagnosticInfo` as a server action <!-- id: 0 -->
- [ ] Rename `getUnparentedMomentsLocal` to `getAllMomentsLocal` and remove root filter <!-- id: 1 -->
- [ ] Update `KnowledgeGraphPage` to reflect "All Moments" vs "Subjects" <!-- id: 2 -->
- [x] Add Diagnostics UI to Knowledge Graph page <!-- id: 3 -->

## Implemented Knowledge Graph improvements and Diagnostics
We renamed the "Moments" tab to "All Moments" and refactored the underlying logic to show a flat list of all moments in the namespace, removing the stale "Roots" concept. We also added a Diagnostics section that allows document-prefix based filtering to verify specific moment presence. Fixed several JSX and type errors that cropped up during the UI refactor.
