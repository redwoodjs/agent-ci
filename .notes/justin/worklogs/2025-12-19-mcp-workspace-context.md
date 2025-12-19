## Problem
The MCP server sets client context using the MCP process working directory.

When Cursor starts the MCP server from a directory outside the repo, the query request includes a cwd and workspace roots that do not match the active repo. The scope router then routes the query to `redwood:internal`.

## Plan
- Accept workspace root inputs from MCP server environment.
- Use these values for query client context (cwd and workspace roots).
- Log the client context sent to the query endpoint.
- Update the Cursor setup script to populate these environment variables via `mcp.json`.

## Progress
- Added environment overrides to the MCP server script:
  - `MACHINEN_MCP_CONTEXT_CWD`
  - `MACHINEN_MCP_CONTEXT_WORKSPACE_ROOTS` (comma-separated)
  - `MACHINEN_MCP_CONTEXT_WORKSPACE_ROOTS_JSON` (JSON array)
- The MCP server now logs the effective client context it sends to `/query`, along with any namespace prefix fields.
- Updated `scripts/setup-cursor.sh` to add `MACHINEN_MCP_CONTEXT_CWD` and `MACHINEN_MCP_CONTEXT_WORKSPACE_ROOTS` to the generated user-wide `~/.cursor/mcp.json`, using `${workspaceFolder}`.
