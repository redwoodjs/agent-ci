# Discord Ingestor

Simple single-operation pipeline that fetches Discord messages and stores them in JSONL format organized by day.

## Overview

This ingestor fetches messages from Discord channels using the Discord Bot API and stores them in R2 as JSONL files organized by date. Each file contains one JSON message object per line.

## Architecture

The ingestor operates in a single operation:

1. Fetch messages from Discord API with pagination
2. Filter messages by date (optional)
3. Group messages by day based on timestamp
4. Store each day's messages in R2 at `discord/{guildID}/{channelID}/{YYYY-MM-DD}.jsonl`

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

### 2. Fetch Messages

Trigger message fetching from Discord.

The `guildID` and `channelID` parameters are optional and default to `679514959968993311` and `1307974274145062912` respectively for easier testing.

**Fetch all messages (using defaults):**

```bash
curl -X POST http://localhost:8787/ingest/discord/fetch \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Fetch all messages (explicit IDs):**

```bash
curl -X POST http://localhost:8787/ingest/discord/fetch \
  -H "Content-Type: application/json" \
  -d '{
    "guildID": "679514959968993311",
    "channelID": "1307974274145062912"
  }'
```

**Fetch messages from a specific date (using defaults):**

```bash
curl -X POST http://localhost:8787/ingest/discord/fetch \
  -H "Content-Type: application/json" \
  -d '{
    "date": "2024-11-04"
  }'
```

**Fetch messages from a date range (using defaults):**

```bash
curl -X POST http://localhost:8787/ingest/discord/fetch \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": "2024-11-01",
    "endDate": "2024-11-04"
  }'
```

Response:

```json
{
  "success": true,
  "days": 3,
  "totalMessages": 142,
  "files": [
    "discord/679514959968993311/1307974274145062912/2024-11-01.jsonl",
    "discord/679514959968993311/1307974274145062912/2024-11-02.jsonl",
    "discord/679514959968993311/1307974274145062912/2024-11-04.jsonl"
  ]
}
```

## JSONL Format

Each file contains one JSON message object per line:

```jsonl
{"id":"123","timestamp":"2024-11-04T10:30:00.000Z","author":{"id":"456","username":"alice","global_name":"Alice"},"content":"Hello world","channel_id":"789","thread":null,"message_reference":null}
{"id":"124","timestamp":"2024-11-04T10:31:15.000Z","author":{"id":"457","username":"bob"},"content":"Hi there!","channel_id":"789","thread":null,"message_reference":{"message_id":"123","channel_id":"789"}}
```

### Message Fields

Each message includes:

- `id`: Discord message ID
- `timestamp`: ISO 8601 timestamp
- `author`: Author object with `id`, `username`, and optional `global_name`
- `content`: Message text content
- `channel_id`: Discord channel ID
- `thread`: Thread metadata (if message is in a thread)
- `message_reference`: Reply metadata (if message is a reply)
- `reactions`: Array of reactions (if any)
- `attachments`: Array of attachments (if any)
- `embeds`: Array of embeds (if any)

## R2 Storage Structure

Files are stored in R2 with this structure:

```
discord/{guildID}/{channelID}/{YYYY-MM-DD}.jsonl
```

Example:

```
discord/679514959968993311/1307974274145062912/2024-11-01.jsonl
discord/679514959968993311/1307974274145062912/2024-11-02.jsonl
discord/679514959968993311/1307974274145062912/2024-11-03.jsonl
```

Messages within each file are sorted chronologically.

## API Endpoint

### POST /ingest/discord/fetch

Fetches messages from a Discord channel and stores them in R2.

**Request Body:**

```typescript
{
  guildID: string;        // Required: Discord guild (server) ID
  channelID: string;      // Required: Discord channel ID
  date?: string;          // Optional: Fetch only this date (YYYY-MM-DD)
  startDate?: string;     // Optional: Start of date range (YYYY-MM-DD)
  endDate?: string;       // Optional: End of date range (YYYY-MM-DD)
}
```

**Response:**

```typescript
{
  success: boolean;
  days: number;           // Number of unique days
  totalMessages: number;  // Total messages fetched
  files: string[];        // R2 paths of created files
}
```

**Validation Rules:**

- Cannot specify both `date` and `startDate/endDate`
- If using date range, both `startDate` and `endDate` are required
- Date format must be YYYY-MM-DD

## Rate Limiting

The ingester monitors Discord API rate limits:

- Checks `X-RateLimit-Remaining` header after each request
- Warns when fewer than 5 requests remain
- Fetches up to 100 messages per API call
- Uses pagination to fetch all messages

## Error Handling

- Discord API errors: Returns 500 with error message
- Validation errors: Returns 400 with validation details
- Missing bot token: Throws error before attempting fetch
- All errors are logged to console

## Implementation

**Files:**

- `ingest.ts`: Main ingestion logic with Discord API interaction
- `routes.ts`: Route handler and validation

See `docs/architecture/discord-ingestion-pipeline.md` for detailed architecture documentation.
