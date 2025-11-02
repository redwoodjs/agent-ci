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
│  ├─ Split by threads/reply chains   │
│  └─ Store splits to R2 bucket       │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│  R2 Bucket                          │
│  discord/{guildID}/{channelID}/     │
│    {timestamp}/split-{N}/           │
│    ├─ conversation.md               │
│    └─ metadata.json                 │
│         (splitType, timestamps,     │
│          participants, threadID)    │
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

**Purpose**: Process raw messages and split them into logical conversation units based on threads and reply chains.

### Message Processing

Processing flow:

1. Query all unprocessed messages from `raw_discord_messages`
2. Split messages into logical groups:
   - **Thread-based splits**: Messages with same `thread_id` are grouped together
   - **Reply chain splits**: Messages linked via `reply_to_message_id` form conversation threads
   - **Orphaned messages**: Individual messages without threads or replies (handled separately)
3. For each conversation split:
   - Generate markdown representation with proper threading structure
   - Store to R2 bucket with split-specific path (`conversation.md` and `metadata.json`)
4. Mark processed messages as processed in `raw_discord_messages`

### Output Files

For each conversation split, two files are created in R2:

#### conversation.md

Markdown representation of the conversation with threading structure:

```markdown
[2024-10-23T14:30:00Z] alice: Here's the main message
> [2024-10-23T14:31:00Z] bob: This is a reply to alice
> > [2024-10-23T14:32:00Z] charlie: This is a nested reply
[2024-10-23T14:35:00Z] dave: This is another root message
```

Threading is indicated by:
- No indent: Root messages (not replies)
- `>` prefix: Direct replies to root messages
- Multiple `>`: Nested reply chains

#### metadata.json

Split metadata:

```json
{
  "splitIndex": 0,
  "splitType": "thread",
  "startTime": "2024-10-23T14:30:00Z",
  "endTime": "2024-10-23T14:35:00Z",
  "messageCount": 4,
  "participantCount": 4,
  "threadID": "1234567890",
  "participantIDs": ["user_id_1", "user_id_2", ...],
  "channelID": "discord_channel_id",
  "guildID": "discord_guild_id"
}
```

### Split Storage

All conversation split metadata is stored in R2 as JSON files alongside the markdown content. Each split has its own directory containing:

- `conversation.md`: Markdown representation with threading
- `metadata.json`: Complete split metadata including splitType, timestamps, participant counts, and IDs

This approach keeps all conversation data self-contained in R2 without requiring database records. Splits can be discovered by listing bucket contents under the channel path.

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

### R2 Storage Structure

Conversation splits are stored entirely in R2:

```
discord/{guildID}/{channelID}/{timestamp}/
  split-0/
    conversation.md
    metadata.json
  split-1/
    conversation.md
    metadata.json
  ...
```

Each `metadata.json` contains:
```json
{
  "splitIndex": 0,
  "splitType": "thread" | "reply_chain" | "orphaned",
  "startTime": "ISO-8601",
  "endTime": "ISO-8601",
  "messageCount": number,
  "participantCount": number,
  "threadID": "discord_thread_id" | null,
  "participantIDs": ["user_id", ...],
  "channelID": "discord_channel_id",
  "guildID": "discord_guild_id"
}
```

## Conversation Splitting Strategy

The store stage implements a hierarchical splitting strategy that prioritizes explicit conversation boundaries:

### 1. Thread-Based Splits (Priority 1)

Messages with identical `thread_id` values are grouped together. Discord threads represent explicit conversation boundaries created by users.

```
Thread ID: "123456"
  - Message A (thread_id: "123456")
  - Message B (thread_id: "123456", reply_to: A)
  - Message C (thread_id: "123456")
```

All messages share the same thread_id → Single split

### 2. Reply Chain Splits (Priority 2)

Messages linked via `reply_to_message_id` form conversation threads. The algorithm:

1. Build a graph of message relationships using `reply_to_message_id`
2. Find root messages (messages not replying to anything)
3. For each root, recursively collect all replies
4. Each root + its reply tree forms one split

```
Root Message A
  → Reply B (reply_to: A)
    → Reply C (reply_to: B)
  → Reply D (reply_to: A)
```

Forms a single reply chain split

### 3. Orphaned Messages (Priority 3)

Messages without `thread_id` or `reply_to_message_id`. These are handled as individual conversation units.

Future work will implement temporal gap detection to group orphaned messages that occur in close succession.

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

Triggers the process stage (splits messages into logical conversations and stores as markdown):

```json
{
  "success": true,
  "message": "Discord processing completed",
  "result": {
    "processedCount": 42,
    "splitsCreated": 8,
    "splitsByType": {
      "thread": 5,
      "reply_chain": 2,
      "orphaned": 1
    }
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

### Thread-Based Splitting

Splitting messages by threads and reply chains provides:

1. **Semantic Coherence**: Each split represents a logical conversation unit
2. **Context Preservation**: Reply chains maintain full context even across temporal gaps
3. **Processing Efficiency**: Smaller, focused conversation units for LLM processing
4. **Topical Grouping**: Discord threads naturally group related discussions
5. **Flexible Storage**: Individual conversations can be retrieved and processed independently

### Incremental Ingestion

Only fetching new messages:

1. **Cost**: Reduces Discord API quota usage
2. **Speed**: Faster ingestion for large channels
3. **Deduplication**: Prevents duplicate artifact creation
4. **State**: Maintains continuous ingestion without manual tracking

## Future Considerations

1. **Temporal Gaps**: For orphaned messages, implement temporal gap detection to group scattered messages into conversation-like units
2. **Reactions**: Include emoji reactions in metadata
3. **Attachments**: Download and store file attachments in bucket
4. **Edits**: Track message edit history
5. **Embeds**: Preserve rich embeds from messages
6. **Batch Configuration**: Allow specifying multiple channels per ingest request
7. **Retention Policy**: Implement automatic cleanup of old raw messages
8. **Thread Merging**: Detect and merge related threads (cross-references, same participants, temporal proximity)
