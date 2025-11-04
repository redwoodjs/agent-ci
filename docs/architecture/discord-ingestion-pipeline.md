# Discord Ingestion Pipeline

## Overview

The Discord ingestion pipeline fetches messages from Discord channels and stores them in R2 as JSONL files organized by date.

This is a single-operation pipeline that:

1. Fetches messages from Discord API with pagination
2. Filters messages by date (optional)
3. Groups messages by day based on timestamp
4. Stores each day's messages in R2 at `discord/{guildID}/{channelID}/{YYYY-MM-DD}.jsonl`

## Architecture

```
┌─────────────────┐
│  Discord API    │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  Ingest Operation (ingest.ts)       │
│  ├─ Fetch messages with pagination  │
│  ├─ Filter by date (optional)       │
│  ├─ Group messages by day           │
│  └─ Write JSONL files to R2         │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│  R2 Bucket                          │
│  discord/{guildID}/{channelID}/     │
│    {YYYY-MM-DD}.jsonl               │
└─────────────────────────────────────┘
```

## Single-Operation Pipeline

### Discord API Interaction

The ingester fetches messages from Discord channels:

**Channel Messages Endpoint:**

- Endpoint: `GET /channels/{channelID}/messages`
- Parameters: `limit=100`, `before={messageID}` for pagination
- Auth: `Authorization: Bot {DISCORD_BOT_TOKEN}`
- Returns: Array of message objects

**Pagination:**

Messages are fetched in batches of 100 using the `before` parameter:

1. Fetch first batch of 100 messages
2. Use the ID of the oldest message as `before` parameter
3. Fetch next batch of 100 messages
4. Repeat until no more messages or date filter boundary reached

**Rate Limiting:**

- Monitors `X-RateLimit-Remaining` header
- Warns when fewer than 5 requests remain
- No automatic backoff (fetches are synchronous)

### Date Filtering

Three filtering modes:

**1. Fetch All Messages (no date parameters)**

Fetches all messages from the channel from newest to oldest.

**2. Fetch Single Day (`date` parameter)**

Fetches only messages with timestamps on the specified date:

- Format: `YYYY-MM-DD`
- Example: `"date": "2024-11-04"`
- Stops fetching when messages older than date are encountered

**3. Fetch Date Range (`startDate` and `endDate` parameters)**

Fetches messages within the date range (inclusive):

- Format: `YYYY-MM-DD`
- Example: `"startDate": "2024-11-01", "endDate": "2024-11-04"`
- Stops fetching when messages older than startDate are encountered

### Message Grouping

Messages are grouped by date extracted from their timestamp:

1. Extract date from timestamp: `timestamp.split('T')[0]`
2. Group messages into Map by date
3. Sort messages within each day chronologically
4. Write each day's messages as separate JSONL file

### R2 Storage

**Path Structure:**

Channel messages:

```
discord/{guildID}/{channelID}/{YYYY-MM-DD}.jsonl
```

Thread messages:

```
discord/{guildID}/{channelID}/{YYYY-MM-DD}-thread-{threadID}.jsonl
```

**File Format:**

JSONL (JSON Lines) - one JSON object per line, newline separated:

```jsonl
{"id":"123","timestamp":"2024-11-04T10:30:00.000Z","author":{"id":"456","username":"alice"},"content":"Hello","channel_id":"789"}
{"id":"124","timestamp":"2024-11-04T10:31:00.000Z","author":{"id":"457","username":"bob"},"content":"Hi","channel_id":"789"}
```

**Message Structure:**

Each JSON object contains the full Discord message:

- `id`: Message ID
- `timestamp`: ISO 8601 timestamp
- `author`: Object with `id`, `username`, `global_name`
- `content`: Message text
- `channel_id`: Channel ID
- `thread`: Thread metadata (if in thread)
- `message_reference`: Reply metadata (if reply)
- `reactions`: Array of reactions (if any)
- `attachments`: Array of attachments (if any)
- `embeds`: Array of embeds (if any)

## API Endpoint

### POST /ingest/discord/fetch

Triggers message fetching from Discord.

**Request:**

```json
{
  "guildID": "679514959968993311",
  "channelID": "1307974274145062912",
  "date": "2024-11-04"
}
```

**Response:**

```json
{
  "success": true,
  "days": 1,
  "totalMessages": 42,
  "totalThreads": 3,
  "totalThreadMessages": 18,
  "files": [
    "discord/679514959968993311/1307974274145062912/2024-11-04.jsonl",
    "discord/679514959968993311/1307974274145062912/2024-11-04-thread-1234567890.jsonl",
    "discord/679514959968993311/1307974274145062912/2024-11-04-thread-1234567891.jsonl",
    "discord/679514959968993311/1307974274145062912/2024-11-04-thread-1234567892.jsonl"
  ]
}
```

**Parameters:**

- `guildID` (required): Discord guild (server) ID
- `channelID` (required): Discord channel ID
- `date` (optional): Fetch only this date (YYYY-MM-DD)
- `startDate` (optional): Start of date range (YYYY-MM-DD)
- `endDate` (optional): End of date range (YYYY-MM-DD)

**Validation:**

- Cannot specify both `date` and `startDate/endDate`
- Date range requires both `startDate` and `endDate`
- Date format must be YYYY-MM-DD

## Implementation Files

### ingest.ts

Main ingestion logic:

**Functions:**

- `fetchMessagesFromDiscord()`: Fetches single batch from Discord API (works for both channels and threads)
- `isMessageInDateRange()`: Checks if message matches date filter
- `shouldContinueFetching()`: Determines if pagination should continue
- `extractThreadInfo()`: Extracts thread IDs and their parent message dates
- `fetchThreadMessages()`: Fetches all messages from a specific thread
- `ingestDiscordMessages()`: Main function orchestrating the pipeline

**Types:**

- `DiscordMessage`: Message structure from Discord API
- `IngestOptions`: Parameters for ingestion
- `IngestResult`: Return type with statistics (days, totalMessages, totalThreads, totalThreadMessages, files)

### routes.ts

Route handler and validation:

**Functions:**

- `validateFetchRequest()`: Validates request body with Zod schema
- `logDiscordRequest()`: Logs request and response
- `fetch()`: Route handler for POST /ingest/discord/fetch

## Configuration

### Environment Variables

```
DISCORD_BOT_TOKEN=your_bot_token_here
```

Add to `.dev.vars` for local development or use `wrangler secret put DISCORD_BOT_TOKEN` for production.

### R2 Bucket

Uses `MACHINEN_BUCKET` binding configured in wrangler.jsonc.

## Error Handling

**Discord API Errors:**

- Returns 500 with error message
- Logs full error to console
- Includes Discord API status and response text

**Validation Errors:**

- Returns 400 with validation details
- Uses Zod for schema validation
- Provides specific error messages for date conflicts

**Rate Limit Warnings:**

- Logs warning when fewer than 5 requests remain
- No automatic backoff or retry
- Continues fetching until complete

## Design Rationale

### Single-Operation Pipeline

A single-operation pipeline provides:

1. **Simplicity**: One endpoint, one operation, straightforward flow
2. **Transparency**: Easy to understand what happens when endpoint is called
3. **Idempotency**: Re-running produces same R2 files (overwrite)
4. **No State Management**: No database tables or processing stages
5. **Direct Storage**: Messages go directly from Discord API to R2

### JSONL Format

JSONL (JSON Lines) format provides:

1. **Line-by-Line Processing**: Can process one message at a time
2. **Streaming**: Can read/write without loading entire file
3. **Append-Friendly**: Easy to add new messages
4. **Standard Format**: Well-supported tooling and libraries
5. **Complete Data**: Preserves full Discord message structure

### Date-Based Organization

Organizing by date provides:

1. **Chronological Access**: Easy to find messages from specific day
2. **Bounded File Sizes**: Each day is separate file
3. **Parallel Processing**: Can process multiple days concurrently
4. **Incremental Updates**: Can fetch only new days
5. **Time-Series Analysis**: Natural grouping for analytics

### Direct R2 Storage

Storing directly in R2 without database provides:

1. **Cost Efficiency**: R2 storage is cheaper than database
2. **Scalability**: R2 handles arbitrary data sizes
3. **Simplicity**: No schema migrations or table management
4. **Flexibility**: Can change message structure without migrations
5. **Archival**: Long-term storage without database overhead

## Thread Collection

The ingestion pipeline collects both channel messages and thread messages.

### Thread Detection

After fetching channel messages, the pipeline scans for messages that have started threads:

1. Check each message for `thread` property
2. Extract `thread.id` from messages with threads
3. Deduplicate thread IDs
4. Fetch messages from each discovered thread

### Thread Message Fetching

Thread messages are fetched using the same endpoint as channel messages:

- Endpoint: `GET /channels/{threadID}/messages`
- Parameters: Same as channel messages (`limit=100`, `before` for pagination)
- Auth: Same bot token
- Rate limiting: Same rate limit pool as channel messages

### Thread Storage

Thread messages are stored in separate JSONL files:

**Path Structure:**

```
discord/{guildID}/{channelID}/{YYYY-MM-DD}-thread-{threadID}.jsonl
```

The date in the filename corresponds to the date of the parent message that started the thread.

**Example:**

```
discord/679514959968993311/1307974274145062912/2024-11-29-thread-1234567890.jsonl
```

### Thread Message Structure

Thread messages use the same structure as channel messages but include additional context:

- `id`: Message ID within the thread
- `timestamp`: ISO 8601 timestamp
- `author`: Object with `id`, `username`, `global_name`
- `content`: Message text
- `channel_id`: Thread ID (not parent channel ID)
- All other standard message fields

### Thread Processing Order

1. Fetch all channel messages for the date range
2. Group channel messages by date
3. Extract thread IDs from channel messages
4. For each thread:
   - Determine parent message date
   - Fetch all thread messages
   - Store in date-stamped thread file
5. Store channel messages in date files

## Future Enhancements

1. **Incremental Fetching**: Track last fetched message and only get new ones
2. **Attachment Download**: Download and store file attachments
3. **Rate Limit Handling**: Implement exponential backoff and retry
4. **Batch Channels**: Support fetching multiple channels in one request
5. **Progress Tracking**: Stream progress updates for long-running fetches
6. **Deduplication**: Skip messages already in R2
7. **Compression**: Compress JSONL files before storing
