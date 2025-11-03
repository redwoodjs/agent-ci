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
│  ├─ Store markdown to R2 bucket     │
│  └─ Store metadata to Durable Object│
└────────────┬────────────────────────┘
             │
             ├──────────────────┐
             │                  │
             ▼                  ▼
┌──────────────────┐  ┌──────────────────┐
│  R2 Bucket       │  │  Durable Object  │
│  conversation.md │  │  Database        │
│  metadata.json   │  │  ─────────────── │
│                  │  │  conversation_   │
│                  │  │    splits table  │
│                  │  │  (queryable)     │
└──────────────────┘  └──────────────────┘
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
   - Insert metadata record into `conversation_splits` table (Durable Object database)
4. Mark processed messages as processed in `raw_discord_messages`

### Output Files

For each conversation split, two files are created in R2:

#### conversation.md

Markdown representation of the conversation with threading structure:

```markdown
[2024-10-23T14:30:00Z] alice: Here's the main message

> [2024-10-23T14:31:00Z] bob: This is a reply to alice
>
> > [2024-10-23T14:32:00Z] charlie: This is a nested reply
> > [2024-10-23T14:35:00Z] dave: This is another root message
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

Conversation splits are stored in two locations:

**Durable Object Database** (`conversation_splits` table):

- Queryable metadata for threads and reply chains only
- Fields: guildID, channelID, splitType, threadID, timestamps, counts, bucketPath
- Enables searching and filtering conversations by type, time, or participants
- Orphaned messages are not tracked in the database

**R2 Bucket**:

- Full markdown content and metadata JSON for structured conversations
- Threads: `discord/{guildID}/{channelID}/threads/{threadID}/`
- Reply chains: `discord/{guildID}/{channelID}/replies/{rootMessageID}/`
- Files: `conversation.md` and `metadata.json`

**Daily Streams** (R2 only):

- Complete chronological index of channel activity per day
- Path: `discord/{guildID}/{channelID}/daily/{YYYY-MM-DD}.md`
- Contains references to threads/reply chains and full content of orphaned messages
- Provides navigable timeline without content duplication

This architecture provides queryability (database), complete conversation preservation (structured R2 artifacts), and chronological indexing (daily streams).

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

### conversation_splits Table

Records logical conversation splits in the Durable Object database:

```sql
CREATE TABLE conversation_splits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildID TEXT NOT NULL,
  channelID TEXT NOT NULL,
  splitType TEXT NOT NULL,  -- "thread", "reply_chain" (orphaned not tracked)
  threadID TEXT,
  startTime TEXT NOT NULL,
  endTime TEXT NOT NULL,
  messageCount INTEGER NOT NULL,
  participantCount INTEGER NOT NULL,
  bucketPath TEXT NOT NULL,
  createdAt TEXT DEFAULT CURRENT_TIMESTAMP
)
```

Note: Orphaned messages are not stored in this table. They appear only in daily stream files.

### R2 Storage Structure

Conversation content stored in R2 using stable paths:

```
discord/{guildID}/{channelID}/
  threads/{threadID}/
    conversation.md
    metadata.json
  replies/{rootMessageID}/
    conversation.md
    metadata.json
  daily/{YYYY-MM-DD}.md
```

Each `metadata.json` contains:

```json
{
  "splitType": "thread" | "reply_chain",
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

Daily stream format:

```markdown
# 2024-10-23

[09:00:00] alice: Quick standalone question here

[09:05:00] → Thread
Messages: 12 | Participants: 4
Duration: 09:05:00 - 10:30:00
Path: discord/guild123/channel456/threads/thread789/

[10:45:00] charlie: Thanks for the help!
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

Messages without `thread_id` or `reply_to_message_id`. These appear only in daily streams with full content, not as separate conversation artifacts.

### 4. Daily Streams

All messages are also represented in daily stream files that provide a complete chronological index:

- **Thread/reply chain references**: Metadata blocks showing message count, participants, duration, and path
- **Orphaned message content**: Full message text inline in the stream
- **Chronological ordering**: Messages ordered by timestamp
- **No duplication**: References point to structured artifacts; only orphaned messages have full content

Daily streams enable viewing channel activity patterns and timeline navigation without reading individual conversation artifacts.

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

### Thread-Based Splitting with Daily Streams

Splitting messages by threads and reply chains with daily stream indexing provides:

1. **Semantic Coherence**: Each structured conversation is a logical unit
2. **Context Preservation**: Reply chains maintain full context across temporal gaps
3. **Processing Efficiency**: Focused conversation units for LLM processing
4. **Topical Grouping**: Discord threads group related discussions
5. **Stable Paths**: Thread and reply chain artifacts use deterministic identifiers
6. **Chronological Access**: Daily streams provide complete timeline view
7. **No Duplication**: Structured conversations stored once, referenced in daily streams

### Three-Layer Storage Architecture

Storing conversations across Durable Object database, R2 artifacts, and daily streams provides:

1. **Queryability**: Database enables filtering structured conversations by type, time, channel, or thread
2. **Completeness**: R2 artifacts preserve full conversation content with stable paths
3. **Timeline Navigation**: Daily streams provide chronological channel activity index
4. **Performance**: Database queries avoid R2 bucket scans; stable paths enable direct access
5. **Durability**: Durable Object provides transactional guarantees for metadata
6. **Archival**: R2 provides cost-effective long-term storage
7. **Idempotency**: Stable paths prevent duplicate artifacts on re-processing

### Incremental Ingestion

Only fetching new messages:

1. **Cost**: Reduces Discord API quota usage
2. **Speed**: Faster ingestion for large channels
3. **Deduplication**: Prevents duplicate artifact creation
4. **State**: Maintains continuous ingestion without manual tracking

## Future Considerations

1. **Reactions**: Include emoji reactions in metadata
2. **Attachments**: Download and store file attachments in bucket
3. **Edits**: Track message edit history
4. **Embeds**: Preserve rich embeds from messages
5. **Batch Configuration**: Allow specifying multiple channels per ingest request
6. **Retention Policy**: Implement automatic cleanup of old raw messages
7. **Thread Merging**: Detect and merge related threads (cross-references, same participants, temporal proximity)
8. **Daily Stream Updates**: When re-processing, merge new entries into existing daily streams rather than overwriting
9. **Thread Names**: Include Discord thread names in daily stream references when available
