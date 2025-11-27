# Discord Ingestor

Hybrid ingestion pipeline that fetches Discord messages and stores them using a daily JSONL format for channels and page-centric JSON with history tracking for threads.

## Overview

This ingestor fetches messages from Discord channels and threads using the Discord Bot API and stores them in R2. The architecture uses a queue-driven backfill system with state management, storing channel messages in daily JSONL files and thread conversations as complete pages with history tracking.

## Architecture

The ingestor uses a two-tier queue architecture:

1. **Scheduler Queue**: Fetches pages of messages and threads from Discord API
2. **Processor Queue**: Processes individual channels and threads
3. **State Management**: Durable Object tracks backfill progress and allows resumption

See `docs/architecture/discord-ingestion-pipeline.md` for detailed architecture documentation.

## Storage Structure

Files are stored in R2 with this hybrid structure:

```
discord/{guildID}/{channelID}/{YYYY-MM-DD}.jsonl
discord/{guildID}/{channelID}/threads/{threadID}/latest.json
discord/{guildID}/{channelID}/threads/{threadID}/history/{timestamp}.json
```

### Channel Messages (Daily JSONL)

Each day's messages are stored in a separate JSONL file:

- One message per line in JSON format
- Contains all non-thread messages for that date
- Sorted chronologically
- Completely regenerated on each backfill
- No history tracking

Example JSONL content:

```jsonl
{"id":"123","timestamp":"2024-11-04T10:30:00.000Z","author":{"username":"alice"},"content":"Hello"}
{"id":"124","timestamp":"2024-11-04T10:31:15.000Z","author":{"username":"bob"},"content":"Hi there!"}
```

### Thread Pages (JSON with History)

Each thread's `latest.json` contains:

- Metadata (guild ID, channel ID, thread ID, timestamps, version hash)
- Starter message from parent channel
- Complete array of thread replies sorted chronologically

### History Diffs (Threads Only)

History files contain JSON diffs showing what changed between thread versions, creating an audit trail. Channel messages do not have history tracking.

## Vectorization

Discord messages are automatically vectorized when stored in R2. The RAG engine processes both channel JSONL files and thread JSON files:

- **Channel Messages**: Each daily JSONL file is indexed as a document, with individual messages as chunks. This allows semantic search across messages within a day.

- **Thread Messages**: Each thread's `latest.json` is indexed as a document, with the starter message and each reply as separate chunks. This maintains conversation context for semantic search.

When files are created or updated in R2, they are automatically enqueued for indexing via the `engine-indexing-queue`. The Discord plugin handles:

- Parsing JSONL files (channel messages) and JSON files (threads)
- Creating chunks with proper metadata (author, timestamp, message ID)
- Reconstructing conversation context for query responses

### Manual Indexing

To manually trigger vectorization for a specific Discord file, use the `/rag/admin/index` endpoint:

```bash
# Index a channel's daily messages
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"r2Key": "discord/123456789/987654321/2024-11-04.jsonl"}' \
  "https://your-domain.workers.dev/rag/admin/index"

# Index a thread
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"r2Key": "discord/123456789/987654321/threads/111222333/latest.json"}' \
  "https://your-domain.workers.dev/rag/admin/index"
```

See the [RAG Engine README](../engine/README.md) for more details on the indexing pipeline.

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
curl -X POST http://localhost:5173/ingest/discord/backfill \
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
curl "http://localhost:5173/ingest/discord/backfill/status?guildID=679514959968993311&channelID=1307974274145062912"
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
curl -X POST http://localhost:5173/ingest/discord/backfill/pause \
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

### 5. Manually Index a Discord File

To manually trigger vectorization for a specific Discord file:

```bash
# Index a channel's daily messages
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"r2Key": "discord/679514959968993311/1307974274145062912/2024-11-04.jsonl"}' \
  "http://localhost:5173/rag/admin/index"

# Index a thread
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"r2Key": "discord/679514959968993311/1307974274145062912/threads/111222333/latest.json"}' \
  "http://localhost:5173/rag/admin/index"
```

Response:

```json
{
  "success": true,
  "message": "Enqueued file for indexing",
  "r2Key": "discord/679514959968993311/1307974274145062912/2024-11-04.jsonl"
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
   - Channel processor: Fetches all non-thread messages, groups by day, generates daily JSONL files
   - Thread processor: Fetches starter message and thread replies, generates `latest.json`, stores diffs
5. On completion, backfill state updates to `completed`
6. On error after retries, job moves to DLQ and backfill pauses

**Note**: Channel JSONL files are completely regenerated on each backfill. Only threads maintain incremental history with diffs.

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

### POST /ingest/discord/webhook

Receives Discord Gateway events and processes them in real-time.

**Headers:**

- `Authorization: Bearer <API_KEY>` (required)

**Request Body:**
Discord Gateway event payload (see [Discord Gateway Events](https://discord.com/developers/docs/topics/gateway-events))

**Response:**

```json
{
  "success": true,
  "message": "Webhook event processed"
}
```

**Supported Event Types:**

- `MESSAGE_CREATE`
- `MESSAGE_UPDATE`
- `MESSAGE_DELETE`
- `THREAD_CREATE`
- `THREAD_UPDATE`

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

## Live Webhook

The Discord ingestor supports live webhook ingestion to receive and process Discord events in real-time, complementing the backfill system.

### Configuration

1. **Discord Bot Setup:**

   - Enable Gateway Intents in Discord Developer Portal:
     - `MESSAGE_CONTENT_INTENT` (required to receive message content)
     - `GUILD_MESSAGES` (required for message events)
     - `GUILDS` (required for guild/channel information)
   - Configure your bot to send Gateway events to the webhook endpoint

2. **Webhook Endpoint:**

   - URL: `https://your-domain.workers.dev/ingest/discord/webhook`
   - Method: `POST`
   - Authentication: Bearer token (API key in `Authorization` header)

3. **API Key Setup:**
   - Set `INGEST_API_KEY` environment variable (same key used for other ingestors)
   - Include in webhook requests: `Authorization: Bearer <your-api-key>`

### Supported Events

The webhook handles the following Discord Gateway events:

- **MESSAGE_CREATE**: New messages are batched and appended to daily JSONL files
- **MESSAGE_UPDATE**: Updates existing messages in-place in daily JSONL files
- **MESSAGE_DELETE**: Removes messages in-place from daily JSONL files
- **THREAD_CREATE**: Processes thread creation, fetches complete thread state
- **THREAD_UPDATE**: Processes thread updates, updates `latest.json` with diffs

### Message Batching

MESSAGE_CREATE events are automatically batched to reduce R2 write operations:

- Messages are accumulated in a Durable Object per daily file
- Batches are flushed when:
  - 100 messages accumulated, OR
  - 60 seconds elapsed since first message in batch
- MESSAGE_UPDATE and MESSAGE_DELETE events flush pending batches before processing

### Example Webhook Request

```bash
curl -X POST https://your-domain.workers.dev/ingest/discord/webhook \
  -H "Authorization: Bearer $INGEST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "t": "MESSAGE_CREATE",
    "d": {
      "id": "1234567890",
      "channel_id": "1307974274145062912",
      "guild_id": "679514959968993311",
      "content": "Hello, world!",
      "timestamp": "2024-11-04T10:30:00.000Z",
      "author": {
        "id": "987654321",
        "username": "alice",
        "global_name": "Alice"
      }
    }
  }'
```

Response:

```json
{
  "success": true,
  "message": "Webhook event processed"
}
```

### Differences from Backfill

- **Backfill**: Fetches complete historical state, regenerates daily JSONL files completely
- **Webhook**: Appends new messages to existing files, updates/deletes messages in-place
- **Threads**: Both systems use the same thread processor with diff tracking
- **Indexing**: Webhook-ingested messages require manual indexing via `/rag/admin/index` endpoint

### Testing

You can test the webhook endpoint with sample Discord Gateway events:

```bash
# Test MESSAGE_CREATE
curl -X POST http://localhost:5173/ingest/discord/webhook \
  -H "Authorization: Bearer $INGEST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "t": "MESSAGE_CREATE",
    "d": {
      "id": "123",
      "channel_id": "456",
      "guild_id": "789",
      "content": "Test message",
      "timestamp": "2024-11-04T10:30:00.000Z",
      "author": {
        "id": "111",
        "username": "testuser"
      }
    }
  }'
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
- `services/channel-processor.ts`: Channel entity processor (generates daily JSONL files)
- `services/thread-processor.ts`: Thread entity processor (generates JSON with history)
- `services/webhook-handler.ts`: Webhook event handler for live ingestion
- `services/backfill-state.ts`: State management functions
- `services/dlq-handler.ts`: Dead-letter queue handler
- `db/backfill-durableObject.ts`: Durable Object for state persistence
- `db/webhook-batcher-durableObject.ts`: Durable Object for message batching
- `db/backfill-migrations.ts`: Database schema migrations
- `utils/discord-api.ts`: Discord API client utilities
- `utils/diff.ts`: Diff generation (used for threads only)
- `utils/thread-to-json.ts`: Thread to JSON conversion

See `docs/architecture/discord-ingestion-pipeline.md` for detailed architecture documentation.
