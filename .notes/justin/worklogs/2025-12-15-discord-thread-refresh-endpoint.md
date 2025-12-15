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
- Updated Discord routes to return a 400 for empty/invalid JSON bodies (instead of throwing `Unexpected end of JSON input` and returning a 500).

## PR title

Discord Ingest: Thread Refresh Endpoint

## Thread Refresh

Previously, the live Discord ingestion pipeline only refreshed a thread's complete history (re-fetching all messages and updating `latest.json`) when thread metadata events occurred (like `THREAD_UPDATE` or `THREAD_LIST_SYNC`). Simply posting a message in an existing, active thread often only emitted a `MESSAGE_CREATE` which was skipped by the thread processor, leading to incomplete history where older replies were missing from the stored page.

We solved this by adding a dedicated **thread refresh endpoint** that allows manual triggering of the full thread sync logic.

This endpoint (`POST /ingestors/discord/thread/refresh`) accepts a target thread ID and triggers the existing `processThreadEvent` logic. This deterministically fetches the complete message history from Discord's API and rewrites the canonical `latest.json` file in R2, ensuring that all historical context—including messages that predated the ingestion hook—is captured and available for vectorization.

Changes:
- Added a `refresh` route that bypasses the event stream and forces a full state sync for a specific thread.
- Updated the route handlers to gracefully handle empty or invalid JSON bodies with 400 errors instead of crashing with 500s.