# Fix Moment Graph UI Inconsistency 2026-01-25

## Investigated reports of UI state loss and inconsistent tree rendering
###
We are seeing reports of the Knowledge Graph UI displaying unexpected tree structures, showing incorrect chains when selecting moments, and losing all data (showing no chains) after navigation or reload. This suggests potential issues in the frontend state management, specifically around how the moment graph is queried and cached, or how the visual representation is constructed from the raw data.

### Plan
- Locate and analyze the moment graph rendering logic in `knowledge-graph-page.tsx`.
- Investigate the state management for selected moments and navigation.
- Reproduce the "no chains" state after reload.
- Fix any stale cache or incorrect filtering logic.

### Tasks
- [x] Analyze `knowledge-graph-page.tsx` rendering logic <!-- id: 0 -->
- [x] Identify state management for moment selection and navigation <!-- id: 1 -->
- [ ] Implement `popstate` listener for browser navigation <!-- id: 4 -->
- [ ] Fix `entityTab` initialization to prevent `selectedRootId` reset on mount <!-- id: 5 -->
- [ ] Add Tree/Chain view toggle and refine node click behavior <!-- id: 6 -->
- [ ] Debug the "no chains after reload" issue <!-- id: 2 -->
- [ ] Implement fixes for tree rendering and state persistence <!-- id: 3 -->

## Identified race condition in state initialization
We found that `entityTab` defaults to `"subjects"`, then the mount effect updates it from the URL. This update triggers another effect that clears `selectedRootId`, effectively losing the URL-provided selection on every reload. We also noted that clicking a node in the Mermaid graph forces a switch to `"chain"` view, which might be jarring and is hard to reverse. Browser navigation is also broken as there is no `popstate` listener.
