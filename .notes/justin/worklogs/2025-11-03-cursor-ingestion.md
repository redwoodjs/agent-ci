# 2025-11-03: Cursor Ingestion

## Problem

I want to capture interactions with Cursor as a data source for our organization's memory system. This involves storing entire conversations, per branch, to understand the development process, particularly the collaboration between human developers and AI. We need a way to track which file changes are authored by AI versus a human.

## Context

The overall project is an organizational memory system with various data ingestion sources. This task focuses on building the ingestion mechanism for Cursor.

-   **Data Storage**: The raw, unstructured data from Cursor should be stored in the `MACHINEN_BUCKET` R2 bucket. The goal is to capture as much data as possible in its original JSON format.
-   **Statefulness**: If any state needs to be managed during the ingestion process, `rwsdk/db` can be used.
-   **Cursor Hooks**: Cursor provides a "Hooks" feature that allows running custom scripts at different stages of the agent loop. This seems to be the primary mechanism for extracting conversation data.
-   **Setup**: The solution must include a way to set up these hooks for any given repository, not just this one. This suggests a need for user-runnable setup scripts.

The existing `discord` ingestor (`src/app/ingestors/discord/`) can serve as a structural reference, but I am not strictly bound to follow it.

## Plan

The plan is to use Cursor's hooks to send conversation data to a webhook, which then stores the raw data in an R2 bucket.

### Tasks

1.  **Research Cursor Hooks**: Analyze the Cursor Hooks documentation to identify the specific hooks needed to capture a complete conversation (user prompts, agent responses, tool calls, file edits). Determine the data payload for each hook and devise a strategy for reconstructing the conversation from these events.

2.  **Design and Implement Ingestion Endpoint**: Create a new route in the application that acts as a webhook endpoint. This endpoint will receive JSON payloads from the Cursor hook scripts and write them to the `MACHINEN_BUCKET` R2 bucket. The objects in R2 could be organized by `conversation_id`.

3.  **Create Hook Script**: Write a simple shell script that can be executed by Cursor's hooks. This script will read the JSON data from standard input and `POST` it to the ingestion endpoint.

4.  **Develop Setup Script**: Create a script that automates the setup of the Cursor hooks for a user. This script will:
    -   Create or update `~/.cursor/hooks.json` to register the necessary hooks.
    -   Place the hook script into `~/.cursor/hooks/`.
    -   Ensure the hook script is executable.

5.  **Implementation and Testing**:
    -   Create a new ingestor module under `src/app/ingestors/cursor/`.
    -   Implement the endpoint and associated services.
    -   Place the hook and setup scripts within the module.
    -   Test the end-to-end flow by running the setup script, interacting with Cursor in this repository, and verifying that the data is correctly ingested and stored in R2.

## 2025-11-04: Refined Storage Strategy

After initial testing, it's clear that storing one JSON file per hook event is too verbose. A better approach is to aggregate the events related to a single user-agent interaction.

### Revised Plan

The new plan is to use a stateful mechanism, likely a Durable Object, to collect all hook events for a single "generation" (a user prompt and the subsequent agent activity) and store them as a single document in R2.

1.  **Stateful Ingestion**: The ingest handler will not write to R2 directly. Instead, it will forward the event data to a Durable Object, keyed by `generation_id`.

2.  **Event Aggregation**: The Durable Object will store the incoming events in memory or its own storage. It will collect all events for a given `generation_id`.

3.  **Consolidation and Storage**: When the `stop` hook event is received for a `generation_id`, the Durable Object will assemble all the collected events into a single JSON document. This document will then be written to the `MACHINEN_BUCKET` in R2. The R2 key can still be based on the `conversation_id` and perhaps the `generation_id` or a timestamp.

4.  **Data Structure**: The aggregated document will contain the `conversation_id`, `generation_id`, and an array of all the hook events in the order they were received. This provides a complete picture of the interaction in a single file.

### Next Steps

Before implementing this, I need to analyze the data from the initial verbose implementation to confirm the best way to structure the aggregated file. I will need to get the sample data from R2 to proceed.

## 2025-11-04: Implementation Complete

After analyzing the hook event data, I implemented the aggregation system using SQLite Durable Objects via `rwsdk/db`. Here's what was built:

### Implementation Details

**Database Layer:**
- Created `CursorEventsDurableObject` extending `SqliteDurableObject` with migrations for an `events` table
- The table stores event data as JSON strings with timestamps for ordering
- Each event is stored temporarily until the `stop` event triggers finalization

**Ingestion Route:**
- POST endpoint at `/ingestors/cursor` receives hook events
- Uses `createDb` with `generation_id` as the key to ensure all events for a single interaction are stored together
- When `stop` event arrives, aggregates all events, writes to R2, and cleans up the database

**Authentication:**
- Implemented API key authentication using a shared `INGEST_API_KEY` environment variable
- Created reusable `requireIngestApiKey` interruptor in `src/app/ingestors/interruptors.ts` for use across all ingestion methods
- Hook script reads API key from environment and includes it in `Authorization: Bearer` header

**Scripts:**
- `hook.sh`: Reads JSON from stdin, sends to ingestion endpoint with API key auth
- `setup.sh`: Automates Cursor hook configuration by creating `~/.cursor/hooks.json` and copying hook script
- Hook script defaults to production URL (`https://machinen.workers.dev/ingestors/cursor`) but can be overridden with `CURSOR_INGEST_URL` env var

**Storage:**
- Aggregated conversations stored in R2 at `cursor-conversations/{conversation_id}/{generation_id}.json`
- Each file contains `conversation_id`, `generation_id`, and an array of all events in chronological order

### Key Decisions

1. **SQLite Durable Objects over simple key-value storage**: Provides structured storage with querying capabilities and aligns with existing patterns in the codebase (e.g., passkey addon)

2. **Database logic outside Durable Object class**: Following the established pattern, business logic lives in route handlers using `createDb`, not inside the Durable Object class itself

3. **Single general API key**: Chose `INGEST_API_KEY` shared across all ingestion methods rather than per-ingestor keys. Simpler to manage, easier for users, and maintains consistent security model. Can add per-ingestor keys later if needed.

4. **Production-first default**: Hook script defaults to production endpoint since most users will use it in production. Local development can override with `CURSOR_INGEST_URL` env var.

5. **Event aggregation by generation_id**: Each user prompt and subsequent agent activity forms a "generation" - all events are grouped by this ID, making it easy to reconstruct complete interactions

### Testing

Created a test route at `/ingestors/cursor/test` that simulates a complete conversation flow, useful for verifying the aggregation logic without needing actual Cursor hooks.

### Files Created/Modified

- `src/app/ingestors/cursor/routes.ts` - Main ingestion endpoint
- `src/app/ingestors/cursor/db/durableObject.ts` - Durable Object class
- `src/app/ingestors/cursor/db/migrations.ts` - Database schema
- `src/app/ingestors/cursor/interruptors.ts` - Re-exports shared interruptor
- `src/app/ingestors/cursor/scripts/hook.sh` - Hook script executed by Cursor
- `src/app/ingestors/cursor/scripts/setup.sh` - Setup automation script
- `src/app/ingestors/cursor/README.md` - Documentation
- `src/app/ingestors/interruptors.ts` - Shared API key authentication
- `src/worker.tsx` - Registered cursor ingestor routes
- `wrangler.jsonc` - Added CursorEventsDurableObject binding

The implementation is complete and ready for use. Users need to:
1. Run the setup script to configure Cursor hooks
2. Set `INGEST_API_KEY` environment variable
3. Set the API key as a Cloudflare Worker secret for production
4. Restart Cursor to activate hooks


## PR Description

### Overview

This implementation leverages Cursor's hooks feature to capture conversation events throughout the agent loop. I opted to aggregate events by generation (user prompt + agent response cycle) rather than storing individual events, because at scale, storing per-event would create an unwieldy structure—either too flattened with everything mixed together, or requiring deeply nested bucket hierarchies. The right level of granularity is per conversation interaction, where each generation represents a complete user-agent exchange.

### What's being added

A POST endpoint was added at `/ingestors/cursor` to receive hook events from Cursor. To handle the multiple events fired for each interaction (e.g., `beforeSubmitPrompt`, `afterFileEdit`, `stop`), a SQLite Durable Object is used to temporarily store all events belonging to a single `generation_id`. When the final `stop` event is received, the system aggregates these events into a single JSON document and writes it to R2. This approach keeps the data for each interaction self-contained and avoids polluting the storage bucket with thousands of small files. I chose SQLite Durable Objects to align with existing patterns in the codebase (like the passkey addon), providing structured storage and ensuring the database logic resides in the route handlers via `createDb`, not within the Durable Object itself.

The endpoint is protected by a shared `INGEST_API_KEY`. A single, general-purpose key was chosen to simplify management for users and provide a consistent security model for all current and future ingestors. Authentication is handled by a reusable `requireIngestApiKey` interruptor.

To streamline the user setup, a `setup.sh` script is included to automatically configure Cursor's `hooks.json` and install the necessary hook script. This script defaults to the production endpoint URL, as that is the most common use case, but can be easily overridden for local development via the `CURSOR_INGEST_URL` environment variable.

### Decisions made

- **Single general API key:** A shared `INGEST_API_KEY` was chosen to simplify management and provide a consistent security model for all ingestors.
- **Production-first defaults:** The hook script defaults to the production endpoint to make the most common setup easier. Local development is supported via an environment variable override.
- **Event aggregation by `generation_id`:** Grouping all events for a single user-agent interaction into one document makes the data much easier to process and analyze later.
- **Database logic outside Durable Object:** Following the established pattern in the codebase, business logic lives in route handlers using `createDb`, keeping the Durable Object itself minimal.

### Storage Format

Conversations are stored in R2 at `cursor-conversations/{conversation_id}/{generation_id}.json`. Each file contains the `conversation_id`, `generation_id`, and an array of all chronological hook events for that interaction.

### Testing & Setup

A test route is available to simulate the ingestion flow. For detailed setup and testing instructions, please see the [README.md](src/app/ingestors/cursor/README.md)

