# Discord Ingestion Pipeline

## Overview

The Discord ingestion pipeline stores Discord channel messages as artifacts through a two-stage process:

1. **Ingest Stage**: Fetch messages from Discord API and store in raw database
2. **Store Stage**: Move raw messages to R2 bucket and create database artifact records

This pipeline maintains an immutable record of Discord conversations in both raw and processed forms.

## Architecture

```
┌─────────────────┐
│  Discord API    │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  Ingest Stage (fetch.ts)            │
│  ├─ Fetch messages from API         │
│  ├─ Handle pagination & rate limits │
│  └─ Store in raw_discord_messages   │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│  raw_discord_messages (SQLite)      │
│  ├─ message_id                      │
│  ├─ channel_id, guild_id            │
│  ├─ author_id, content              │
│  ├─ timestamp, raw_data             │
│  └─ processed_state: unprocessed    │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│  Process Stage (process.ts)         │
│  ├─ Read unprocessed messages       │
│  ├─ Store to R2 bucket              │
│  └─ Create artifact records         │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│  R2 Bucket                          │
│  discord/{guildID}/{channelID}/     │
│    {timestamp}/                     │
│    ├─ messages.json                 │
│    └─ metadata.json                 │
└─────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│  artifacts table                    │
│  ├─ sourceID                        │
│  ├─ bucketPath                      │
│  └─ createdAt, updatedAt            │
└─────────────────────────────────────┘
```

## Stage 1: Ingest (fetch.ts)

**Purpose**: Fetch messages from Discord and store in raw format.

### Discord API Interaction

- Endpoint: `GET /channels/{channelID}/messages`
- Rate limit handling: Exponential backoff with Retry-After headers
- Pagination: Uses message ID cursors to fetch older messages
- Configuration: Max 10 messages per request, 100 max loops

### Rate Limiting

Discord API enforces rate limits. The ingester:

1. Checks `X-RateLimit-Remaining` header
2. Parses `X-RateLimit-Reset-After` header for wait duration
3. On 429 response: Applies exponential backoff (2^retryCount \* 1000ms)
4. Maximum 3 retries before failure

### Message Storage

Messages are stored in `raw_discord_messages` table with:

```sql
{
  message_id: string,        -- Primary key
  channel_id: string,        -- Discord channel ID
  guild_id: string,          -- Discord guild (server) ID
  author_id: string,         -- Discord user ID
  content: string,           -- Raw message text
  timestamp: string,         -- ISO 8601 timestamp
  thread_id: string | null,  -- Thread ID if in thread
  raw_data: string,          -- Full JSON from Discord API
  ingested_at: string,       -- When ingested (auto)
  processed_state: 'unprocessed' | 'processed'
}
```

### Incremental Ingestion

The ingester queries for the most recent message in `raw_discord_messages` and uses it as a cursor to fetch only new messages from Discord, avoiding duplicate storage and API overhead.

## Stage 2: Store (process.ts)

**Purpose**: Move raw messages to persistent storage and create artifact records.

### Message Processing

Processing flow:

1. Query all unprocessed messages grouped by channel and guild
2. For each group, create timestamp-based R2 bucket directory
3. Generate output files:
   - `messages.json`: Normalized message data
   - `metadata.json`: Ingestion metadata
4. Create artifact record in database
5. Mark messages as processed in raw table

### Output Files

#### messages.json

Normalized message structure:

```json
[
  {
    "id": "message_id",
    "content": "message text",
    "timestamp": "2024-10-23T14:30:00Z",
    "author": {
      "id": "discord_user_id",
      "username": "discord_username"
    },
    "channel_id": "channel_id"
  }
]
```

#### metadata.json

Ingestion metadata:

```json
{
  "messageCount": 42,
  "lastMessageID": "newest_message_id",
  "firstMessageID": "oldest_message_id",
  "channelID": "discord_channel_id",
  "guildID": "discord_guild_id",
  "ingestedAt": "2024-10-23T15:00:00Z"
}
```

### Source Management

The processor checks if a Discord source exists, creating one if needed:

```sql
INSERT INTO sources (type, name, description, bucket)
VALUES ('discord', 'Discord {channelID}',
        '{"guildID": "...", "channelID": "..."}', 'default')
```

This allows the system to track which Discord channels have been ingested and relate artifacts back to their source.

## Database Schema

### raw_discord_messages Table

Temporary storage for fetched messages during ingestion:

```sql
CREATE TABLE raw_discord_messages (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  guild_id TEXT,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  thread_id TEXT,
  raw_data TEXT NOT NULL,
  ingested_at TEXT DEFAULT CURRENT_TIMESTAMP,
  processed_state TEXT DEFAULT 'unprocessed'
)
```

- Populated by: Ingest stage
- Consumed by: Process stage
- Lifecycle: Rows are marked as processed, but typically not deleted for audit trail

### Artifact Record

References in main database:

```sql
CREATE TABLE artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sourceID INTEGER NOT NULL REFERENCES sources(id),
  bucketPath TEXT NOT NULL,  -- "discord/{guildID}/{channelID}/{timestamp}/"
  createdAt TEXT,
  updatedAt TEXT
)
```

- Created by: Process stage
- Contains: Reference to R2 bucket path where markdown files are stored

## API Endpoints

### POST /ingest

Triggers the ingest stage:

```json
{
  "success": true,
  "message": "Discord ingestion started",
  "result": [
    {
      "channelID": "1307974274145062912",
      "guildID": "679514959968993311",
      "result": {
        "messageCount": 42,
        "firstMessageID": "...",
        "lastMessageID": "..."
      }
    }
  ]
}
```

### POST /store

Triggers the process stage (converts raw messages to markdown):

```json
{
  "success": true,
  "message": "Discord processing completed",
  "result": {
    "processedCount": 42,
    "artifactsCreated": 1
  }
}
```

## Configuration

### Environment Variables

```
DISCORD_BOT_TOKEN=your_bot_token_here
```

### Credentials Database

Stored in Durable Object with `rawDiscordDb`:

```typescript
const rawDiscordDb = new Sql(env.MACHINEN_DB);
```

## Error Handling

### Ingest Stage

- Discord API errors: Logged and included in response
- Rate limit exceeded: Retried up to 3 times
- Database errors: Transaction rolled back

### Process Stage

- Missing source: Created automatically
- Bucket write failures: Logged, artifact not created
- Database transaction failures: Caught and logged

Both stages wrap operations in try-catch blocks and return detailed error information for debugging.

## Design Rationale

### Two-Stage Pipeline

Separating ingest and process provides benefits:

1. **Decoupling**: Fetching and transformation are independent
2. **Resilience**: If storing fails, raw messages are still available
3. **Flexibility**: Can re-process with different formats or parameters
4. **Audit Trail**: Raw Discord API responses are preserved
5. **Scheduling**: Can run stages at different intervals

### Incremental Ingestion

Only fetching new messages:

1. **Cost**: Reduces Discord API quota usage
2. **Speed**: Faster ingestion for large channels
3. **Deduplication**: Prevents duplicate artifact creation
4. **State**: Maintains continuous ingestion without manual tracking

## Future Considerations

1. **Markdown Format**: Convert messages to markdown (e.g., `[timestamp] username: message`) for semantic processing and LLM embeddings
2. **Thread Handling**: Recursively ingest messages from Discord threads
3. **Reactions**: Include emoji reactions in metadata
4. **Attachments**: Download and store file attachments in bucket
5. **Edits**: Track message edit history
6. **Embeds**: Preserve rich embeds from messages
7. **Batch Configuration**: Allow specifying multiple channels per ingest request
8. **Retention Policy**: Implement automatic cleanup of old raw messages
