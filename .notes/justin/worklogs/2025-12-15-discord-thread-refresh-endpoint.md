# 2025-12-15 - Discord thread refresh endpoint

## Problem
Live Discord ingestion does not reliably refetch full thread history when a thread gets a new message. This can leave older thread replies missing from the stored thread page.

## Context
- Thread pages are stored in R2 as `discord/{guildID}/{channelID}/threads/{threadID}/latest.json`.
- `processThreadEvent` fetches the full thread message history and rewrites `latest.json`.
- Live ingestion currently only calls `processThreadEvent` on thread lifecycle events, not on thread message events.

## Plan
- Add a small HTTP endpoint that triggers `processThreadEvent` for a specific thread.
- Protect the endpoint with the existing API key interruptor.
- Update the Discord ingestor README with a curl example.

## Notes
- Implemented `POST /ingest/discord/thread/refresh` that calls the thread processor and returns the R2 key for the updated `latest.json`.
- Reused the existing API key interruptor so the endpoint can be used in dev without extra setup, but can be gated in environments where `API_KEY` is set.
- Ran file-scoped lint checks on the touched files.
- Full repo TypeScript check is currently not clean in this workspace and the generate script expects dependencies to be installed (it also tries to run `openapi-typescript`).
