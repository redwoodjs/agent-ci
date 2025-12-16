# Cursor ingest hook logging (2025-12-16)

## Problem
Cursor hook ingestion works on my machine but fails for someone else. The hook script sends a POST request in the background and discards curl output, so failures are silent. There is also an environment variable mismatch between setup output (MACHINEN_API_KEY) and the hook script (INGEST_API_KEY).

## Context
- Hook script path in repo: src/app/ingestors/cursor/scripts/hook.sh
- Installed hook location: ~/.cursor/hooks/machinen-ingest-hook.sh
- Desired log location: /tmp/machinen/cursor/ingestion.log

## Plan
- Add append-only verbose logging to /tmp/machinen/cursor/ingestion.log
- Record endpoint URL, auth env presence, payload size, and curl result (status/exit, stderr)
- Keep hook non-blocking (curl stays backgrounded)
- Accept MACHINEN_API_KEY as a fallback for INGEST_API_KEY
- Update setup script messaging to match the hook

## Changes
- Updated hook script to append structured logs to /tmp/machinen/cursor/ingestion.log.
- Hook reads INGEST_API_KEY and falls back to MACHINEN_API_KEY.
- Hook records endpoint URL selection, payload byte count and sha256, and curl http_code/exit/stderr.
- Fixed background logging for failure cases by disabling set -e around the curl call.
- Updated setup script output to mention hook env var compatibility and log file path.

## Smoke check
- Ran the hook against an unreachable URL with a short timeout.
- Log recorded curl_exit=7, http_code=000, and curl stderr.
