# Machine-Readable Knowledge Graph Data 2026-01-25

## Decided to implement a JSON endpoint for Knowledge Graph
###
The user requested a machine-readable format for the Knowledge Graph audit view to facilitate easier parsing and analysis by the AI. We found that the current routing system allows for handler functions that return `Response.json`. We will implement a new route `/audit/knowledge-graph.json` that consolidates the data for the requested namespace, prefix, and root ID.

### Plan
- Implement a JSON handler that reuses logic from existing server actions.
- Register the `/knowledge-graph.json` route in the audit routes.
- Support query parameters for namespace, prefix, tab, and rootId to match the UI state.

### Tasks
- [ ] Create `src/app/pages/audit/subpages/knowledge-graph-json.ts` with the handler logic <!-- id: 0 -->
- [ ] Register the route in `src/app/pages/audit/routes.tsx` <!-- id: 1 -->
- [ ] Verify the endpoint returns correctly formatted JSON <!-- id: 2 -->

## Implemented Knowledge Graph JSON endpoint
###
We implemented a new endpoint `/audit/knowledge-graph.json` that provides machine-readable data for the Knowledge Graph audit view. This endpoint supports the same filtering parameters as the UI (`namespace`, `prefix`, `tab`, `rootId`). We also added `getAllMoments` to the moment graph database library to support listing all moments without unparented filtering. Verified the endpoint locally using provided API keys.
