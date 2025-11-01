# Discord Ingestor

Two-stage pipeline that ingests Discord messages and converts them to markdown artifacts.

## Overview

This ingestor fetches messages from Discord channels using the Discord Bot API and stores them as artifacts in the Machinen R2 bucket. Messages are converted to markdown format for semantic processing and subject extraction.

## Architecture

The ingestor operates in two stages:

**Stage 1: Ingest** (`ingest.ts`)

- Fetches messages from Discord API
- Handles pagination and rate limiting
- Stores raw messages in SQLite `raw_discord_messages` table

**Stage 2: Store** (`process.ts`)

- Reads unprocessed messages from SQLite
- Stores message data to R2 bucket
- Creates artifact records in main database

See [discord-ingestion-pipeline.md](../../docs/architecture/discord-ingestion-pipeline.md) for detailed architecture documentation.
`

## Database Files

- `migrations.ts`: Creates `raw_discord_messages` table in Durable Object SQLite
- The main project migrations in `src/db/migrations.ts` add the related `sources` and `artifacts` tables

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

### 2. Start Ingest

Trigger message fetching from Discord:

```bash
curl -X POST http://localhost:8787/ingestors/discord/ingest
```

Response:

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

### 3. Process Messages

Convert raw messages to markdown and create artifacts:

```bash
curl -X POST http://localhost:8787/ingestors/discord/store
```

Response:

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

## Conversation Splitting and Subject Extraction

After storing messages as artifacts, you can split them into conversations and extract subjects.

### 4. Split Conversations

Split Discord artifacts into logical conversation units based on temporal gaps and thread relationships:

```bash
curl -X POST http://localhost:8787/ingestors/discord/split-conversations
```

Or process a specific artifact:

```bash
curl -X POST "http://localhost:8787/ingestors/discord/split-conversations?artifactID=1"
```

Response:

```json
{
  "success": true,
  "message": "Conversation splitting completed",
  "result": {
    "processed": 5,
    "errors": []
  }
}
```

This creates:

- `conversation_splits` records in the database
- Markdown files in R2: `discord/{guildID}/{channelID}/{timestamp}/split-{index}/conversation.md`
- Metadata files: `metadata.json` with split details

### 5. Extract Subjects

Use LLM to extract subjects from conversation splits:

```bash
curl -X POST http://localhost:8787/ingestors/discord/extract-subjects
```

Or process a specific conversation split:

```bash
curl -X POST "http://localhost:8787/ingestors/discord/extract-subjects?conversationSplitID=1"
```

Or process all splits for a specific artifact:

```bash
curl -X POST "http://localhost:8787/ingestors/discord/extract-subjects?artifactID=1"
```

Response:

```json
{
  "success": true,
  "message": "Subject extraction completed",
  "result": {
    "processed": 5,
    "created": 5,
    "errors": []
  }
}
```

This creates:

- `subjects` records in the database with extracted subject names
- Subject JSON in R2: `subject.json` with facets, aliases, and line mappings

## Pipeline Overview

The complete Discord ingestion pipeline:

1. **Ingest** (`/ingest`) - Fetch messages from Discord API → `raw_discord_messages` table
2. **Store** (`/store`) - Create artifacts in database and store to R2 → `artifacts` table
3. **Split** (`/split-conversations`) - Split into conversation units → `conversation_splits` table
4. **Extract** (`/extract-subjects`) - LLM-based subject extraction → `subjects` table

## Database Schema

### raw_discord_messages (Durable Object SQLite)

- `message_id` - Discord message ID
- `channel_id` - Discord channel ID
- `guild_id` - Discord guild/server ID
- `author_id` - Discord user ID
- `content` - Message text content
- `timestamp` - ISO 8601 timestamp
- `thread_id` - Discord thread ID (if in thread)
- `reply_to_message_id` - ID of message being replied to
- `reply_to_channel_id` - Channel ID if cross-channel reply
- `raw_data` - Full JSON from Discord API
- `ingested_at` - Ingestion timestamp
- `processed_state` - 'unprocessed' | 'processed'

### conversation_splits (Main database)

- `id` - Primary key
- `artifactID` - Reference to artifacts table
- `splitType` - 'temporal' | 'thread' | 'combined'
- `startTime` - ISO timestamp of first message
- `endTime` - ISO timestamp of last message
- `messageCount` - Number of messages in split
- `participantCount` - Number of unique participants
- `threadCount` - Number of threads in split
- `topics` - JSON array of topics (nullable)
- `metadata` - JSON with bucketPath and other metadata
- `createdAt` - Creation timestamp
