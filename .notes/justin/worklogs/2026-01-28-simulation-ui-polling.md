
## 2026-01-28 16:55 Implement Live Polling for Simulation Logs

We have implemented live polling for the simulation logs to address the user's request for automatic updates without page reloads.

### Changes
*   **Refactored Logs UI**: Moved the log viewer logic from `simulation-runs-page.tsx` (server component) to a new client component `simulation-logs-viewer.tsx`.
*   **Server Action**: Added `getSimulationRunLogStateAction` in `simulation-actions.ts` to allow the client component to fetch the latest run status and events.
*   **Polling**: Implemented a 2-second polling interval in `SimulationLogsViewer` to keep the logs fresh.

### Verification
*   We verified that the initial state is passed from the server component to avoid hydration issues.
*   The client component polls the server action and updates the text areas for both "Events" and "Run snapshot" views.
*   We respected the existing "Log view" navigation structure (events vs run).
