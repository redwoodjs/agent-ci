# Discord Ingestor

Page-centric ingestion pipeline that fetches Discord messages and stores them as denormalized conversation pages with history tracking.

## Overview

This ingestor fetches messages from Discord channels and threads using the Discord Bot API and stores them in R2 as JSON documents with history diffs. The architecture mirrors the GitHub ingestion pipeline, using a queue-driven backfill system with state management.

## Architecture

The ingestor uses a two-tier queue architecture:

1. **Scheduler Queue**: Fetches pages of messages and threads from Discord API
2. **Processor Queue**: Processes individual channels and threads, generating `latest.json` files
3. **State Management**: Durable Object tracks backfill progress and allows resumption

See `docs/architecture/discord-ingestion-pipeline.md` for detailed architecture documentation.

## Storage Structure

Files are stored in R2 with this page-centric structure:

```
discord/{guildID}/{channelID}/latest.json
discord/{guildID}/{channelID}/history/{timestamp}.json
discord/{guildID}/{channelID}/threads/{threadID}/latest.json
discord/{guildID}/{channelID}/threads/{threadID}/history/{timestamp}.json
```

### Channel Pages

Each channel's `latest.json` contains:
- Metadata (guild ID, channel ID, timestamps, version hash)
- Complete array of non-thread messages sorted chronologically

### Thread Pages

Each thread's `latest.json` contains:
- Metadata (guild ID, channel ID, thread ID, timestamps, version hash)
- Starter message from parent channel
- Complete array of thread replies sorted chronologically

### History Diffs

History files contain JSON diffs showing what changed between versions, creating an audit trail of all modifications.

## Quick Start

### 1. Configure Discord Bot Token

Set `DISCORD_BOT_TOKEN` environment variable:

**Development** (`.dev.vars`):

```
DISCORD_BOT_TOKEN=your_bot_token_here
```

**Production**:

```bash
wrangler secret put DISCORD_BOT_TOKEN
```

### 2. Start Backfill

Trigger a backfill for a Discord channel:

```bash
curl -X POST http://localhost:8787/ingest/discord/backfill \
  -H "Content-Type: application/json" \
  -d '{
    "guildID": "679514959968993311",
    "channelID": "1307974274145062912"
  }'
```

Response:

```json
{
  "success": true,
  "guild_channel_key": "679514959968993311/1307974274145062912",
  "message": "Backfill job started"
}
```

### 3. Check Status

Query the backfill status:

```bash
curl "http://localhost:8787/ingest/discord/backfill/status?guildID=679514959968993311&channelID=1307974274145062912"
```

Response:

```json
{
  "success": true,
  "guild_channel_key": "679514959968993311/1307974274145062912",
  "state": {
    "status": "in_progress",
    "messages_cursor": "1234567890",
    "threads_cursor": null,
    "error_message": null,
    "error_details": null
  }
}
```

Status values:
- `pending`: Backfill has been initiated but not started
- `in_progress`: Backfill is actively running
- `completed`: Backfill has finished successfully
- `paused`: Backfill was manually paused
- `paused_on_error`: Backfill encountered an error and has been paused

### 4. Pause Backfill

Manually pause a running backfill:

```bash
curl -X POST http://localhost:8787/ingest/discord/backfill/pause \
  -H "Content-Type: application/json" \
  -d '{
    "guildID": "679514959968993311",
    "channelID": "1307974274145062912"
  }'
```

Response:

```json
{
  "success": true,
  "guild_channel_key": "679514959968993311/1307974274145062912",
  "message": "Backfill paused"
}
```

## How It Works

### Backfill Process

1. User initiates backfill via `/backfill` endpoint
2. System creates backfill state entry with `pending` status
3. Scheduler queue job starts:
   - Fetches pages of messages from Discord API
   - Discovers threads from message metadata
   - Enqueues channel processor job
   - Enqueues thread processor jobs for each discovered thread
4. Processor queue consumes jobs:
   - Channel processor: Fetches all non-thread messages, generates `latest.json`, stores diffs
   - Thread processor: Fetches starter message and thread replies, generates `latest.json`, stores diffs
5. On completion, backfill state updates to `completed`
6. On error after retries, job moves to DLQ and backfill pauses

### State Management

A Durable Object (`DiscordBackfillStateDO`) tracks:
- Backfill status
- Pagination cursors for messages and threads
- Error messages and details if issues occur

The backfill process is resumable. If a backfill is paused or encounters an error, you can resume by starting a new backfill for the same channel. It will continue from where it left off.

### Queue System

**Scheduler Queue (`DISCORD_SCHEDULER_QUEUE`):**
- Fetches pages of data from Discord API (100 messages per page)
- Tracks pagination state using message IDs
- Enqueues individual processing jobs

**Processor Queue (`DISCORD_PROCESSOR_QUEUE`):**
- Processes individual channels or threads
- Fetches full current state from Discord API
- Generates `latest.json` and history diffs
- Idempotent operations (safe to retry)

**Dead-Letter Queue:**
- If a processor job fails after 3 retries, it moves to DLQ
- DLQ handler updates backfill state to `paused_on_error`
- Prevents infinite retry loops while preserving error information

### Error Handling

If a backfill encounters an error:
1. Failed jobs retry up to 3 times
2. After exhausting retries, job moves to dead-letter queue
3. DLQ handler updates backfill state to `paused_on_error`
4. Error message and details are stored in backfill state
5. Backfill can be resumed after fixing the underlying issue

## API Endpoints

### POST /ingest/discord/backfill

Starts a backfill for a Discord channel.

**Request Body:**

```json
{
  "guildID": "679514959968993311",
  "channelID": "1307974274145062912"
}
```

**Response:**

```json
{
  "success": true,
  "guild_channel_key": "679514959968993311/1307974274145062912",
  "message": "Backfill job started"
}
```

### POST /ingest/discord/backfill/pause

Pauses a running backfill.

**Request Body:**

```json
{
  "guildID": "679514959968993311",
  "channelID": "1307974274145062912"
}
```

**Response:**

```json
{
  "success": true,
  "guild_channel_key": "679514959968993311/1307974274145062912",
  "message": "Backfill paused"
}
```

### GET /ingest/discord/backfill/status

Checks the status of a backfill.

**Query Parameters:**
- `guildID`: Discord guild (server) ID
- `channelID`: Discord channel ID

**Response:**

```json
{
  "success": true,
  "guild_channel_key": "679514959968993311/1307974274145062912",
  "state": {
    "status": "completed",
    "messages_cursor": null,
    "threads_cursor": null,
    "error_message": null,
    "error_details": null
  }
}
```

## Rate Limiting

The ingestor monitors Discord API rate limits:
- Checks `X-RateLimit-Remaining` header after each request
- Automatically retries with exponential backoff when rate limited
- Fetches up to 100 messages per API call
- Adds 1-second delay between pagination requests

## Implementation

**Core Files:**

- `services/scheduler-service.ts`: Scheduler queue consumer, handles pagination
- `services/processor-service.ts`: Processor queue coordinator
- `services/channel-processor.ts`: Channel entity processor
- `services/thread-processor.ts`: Thread entity processor
- `services/backfill-state.ts`: State management functions
- `services/dlq-handler.ts`: Dead-letter queue handler
- `db/backfill-durableObject.ts`: Durable Object for state persistence
- `db/backfill-migrations.ts`: Database schema migrations
- `utils/discord-api.ts`: Discord API client utilities
- `utils/diff.ts`: Diff generation
- `utils/channel-to-json.ts`: Channel to JSON conversion
- `utils/thread-to-json.ts`: Thread to JSON conversion

See `docs/architecture/discord-ingestion-pipeline.md` for detailed architecture documentation.
