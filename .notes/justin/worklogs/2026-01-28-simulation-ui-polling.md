
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

## 2026-01-28 17:22 PR Draft: Implement Live Polling and Auto-Scrolling for Simulation Logs

### Title
Implement Live Polling and Auto-Scrolling for Simulation Logs

### Description
#### Problem & Context
The simulation page currently requires a manual refresh to view log progress and state updates. This creates a fragmented user experience where we have to constantly reload to track active simulation runs. Additionally, during long runs, we had to manually scroll to the bottom of the log textarea to see the latest entries.

#### Solution & Implementation
We refactored the log viewer from a static react server component into a polling client component.
- **Polling Mechanism**: Implemented a 2-second polling interval using a dedicated server action that fetches the latest event log and run state.
- **Client Refactor**: Extracted the log UI into a new client component to manage local state and effects. We pass the initial server-fetched state as props to ensure immediate rendering without hydration flicker.
- **Serialization Fix**: Resolved a "Functions cannot be passed directly to Client Components" error by moving URL generation logic for log view toggles directly into the client component.
- **Auto-Scrolling**: Added a "stick to bottom" behavior for the log textareas. The UI detects if we are at the bottom and automatically scrolls when new data arrives. If we manually scroll up, auto-scrolling pauses and presents a status indicator.

#### Validation
Verified by starting simulation runs and observing the logs update automatically in real-time. Confirmed that switching between "Events" and "Run snapshot" maintains polling state and that the auto-scroll behavior correctly toggles based on manual interaction.
