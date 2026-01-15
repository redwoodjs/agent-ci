This directory organizes the engine **by phase**.

Each phase should have a single directory that can contain:

- `core/`: shared core/orchestrator logic (used by both live + simulation)
- `live/`: live wiring (adapters/ports)
- `simulation/`: simulation wiring (adapters/ports + runner phase entrypoint)
- `routes/`: admin/api handlers for inspecting artifacts (optional)
- `ui/`: audit/admin UI components for inspecting artifacts (optional)

Goal: adding/removing/re-ordering phases should be “add/remove a directory + update a small registry”, not a scattered multi-file edit across runners/adapters/UI/routes.

