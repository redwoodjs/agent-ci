Title: Discord Ingestor

## Summary

A Discord data ingestor that periodically fetches messages from specified Discord channels and stores them as artifacts in Machinen's R2 bucket.

## Architecture

The ingestor follows Machinen's Sources → Artifacts → Subjects pattern:

1. **Source**: Represents a Discord channel configuration (stored in `sources` table)
2. **Artifact**: Immutable capture of messages from the channel (stored in `artifacts` table + R2)
3. **Subjects**: Derived concepts extracted from the messages (to be implemented)

## Components

### Service (`src/app/services/discord.ts`)

- `DiscordIngestorService`: Handles fetching and storing Discord messages
- `ingestDiscordMessages()`: Main entry point that processes all Discord sources

Key features:

- Incremental ingestion (fetches only new messages)
- Pagination support (handles channels with >100 messages)
- Multiple storage formats (JSON + readable text)
- Metadata tracking (message counts, ID ranges, timestamps)

### Worker Integration (`src/worker.tsx`)

Two ingestion methods:

1. **Scheduled** (Cron): Runs every 6 hours via Cloudflare Cron Triggers
2. **Manual**: HTTP endpoint at `/ingest/discord` for on-demand ingestion

### Configuration (`wrangler.jsonc`)

Cron trigger configured at:

```json
"triggers": {
  "crons": ["0 */6 * * *"]
}
```

## Data Flow

```
Discord API
    ↓
DiscordIngestorService.fetchMessages()
    ↓
Store in R2 Bucket:
  - messages.json (structured data)
  - messages.txt (readable format)
  - metadata.json (ingestion metadata)
    ↓
Create artifact record in database
```

## Bucket Structure

```
discord/
  {guildID}/
    {channelID}/
      {timestamp}/
        messages.json
        messages.txt
        metadata.json
```

## API Endpoints

### `GET /ingest/discord`

Manually triggers Discord ingestion for all configured sources.

**Response:**

```json
{
  "results": [
    {
      "sourceID": 1,
      "result": {
        "artifactID": 7,
        "messageCount": 42
      }
    }
  ]
}
```

## Database Schema

### Sources Table

```sql
CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,  -- "discord"
  description TEXT,    -- JSON: {"guildID": "...", "channelID": "..."}
  bucket TEXT,         -- "discord/"
  url TEXT,           -- Discord channel URL
  createdAt TEXT,
  updatedAt TEXT
);
```

### Artifacts Table

```sql
CREATE TABLE artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sourceID INTEGER NOT NULL REFERENCES sources(id),
  bucketPath TEXT NOT NULL,  -- "discord/{guildID}/{channelID}/{timestamp}/"
  createdAt TEXT,
  updatedAt TEXT
);
```

## Configuration

### Environment Variables

- `DISCORD_BOT_TOKEN`: Bot authentication token (required)

Add to `.dev.vars` for local development:

```
DISCORD_BOT_TOKEN=your_token_here
```

For production:

```bash
wrangler secret put DISCORD_BOT_TOKEN
```

### Creating a Discord Source

Insert a record in the `sources` table:

```sql
INSERT INTO sources (name, type, description, bucket, url, createdAt, updatedAt)
VALUES (
  'RedwoodJS #core-team',
  'discord',
  '{"guildID": "679514959968993311", "channelID": "1307974274145062912"}',
  'discord/',
  'https://discord.com/channels/679514959968993311/1307974274145062912',
  datetime('now'),
  datetime('now')
);
```

## Future Enhancements

1. **Subject Extraction**: Parse messages to extract discussion topics/subjects
2. **Thread Support**: Handle Discord threads within channels
3. **Reaction Tracking**: Store message reactions
4. **Attachment Handling**: Download and store file attachments
5. **Multiple Channels**: Support ingesting multiple channels per source
6. **Webhook Integration**: Real-time ingestion via Discord webhooks
7. **Rate Limit Handling**: Implement exponential backoff for API rate limits

## References

- [Discord API Documentation](https://discord.com/developers/docs/intro)
- [Discord Bot Setup Guide](./discord-ingestor-setup.md)
- [Machinen Architecture: Sources-Artifacts-Subjects](./architecture/sources-artifacts-subjects.md)

Guild ID: 679514959968993311
#SDK Channel ID: 1307974274145062912
