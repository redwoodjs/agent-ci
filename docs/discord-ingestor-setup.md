Title: Discord Ingestor Setup

## Overview

The Discord ingestor fetches messages from specified Discord channels and stores them as artifacts in Machinen. Messages are fetched periodically via a cron job (every 6 hours) or can be triggered manually.

## Setup Steps

### 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and give it a name
3. Navigate to the "Bot" section
4. Click "Add Bot"
5. Under "Token", click "Reset Token" and copy the token (you'll need this for `DISCORD_BOT_TOKEN`)
6. Under "Privileged Gateway Intents", enable:
   - Message Content Intent (required to read message content)

### 2. Add Bot to Your Server

1. In the Discord Developer Portal, go to "OAuth2" → "URL Generator"
2. Select scopes:
   - `bot`
3. Select bot permissions:
   - `Read Messages/View Channels`
   - `Read Message History`
4. Copy the generated URL and open it in a browser
5. Select the server you want to add the bot to

### 3. Get Guild ID and Channel ID

To get these IDs, you need to enable Developer Mode in Discord:

1. Open Discord
2. Go to User Settings → Advanced
3. Enable "Developer Mode"

To get the Guild ID:

- Right-click on the server icon → Copy Server ID

To get the Channel ID:

- Right-click on the channel name → Copy Channel ID

### 4. Configure Environment Variables

Add to your `.dev.vars` file (for local development):

```
DISCORD_BOT_TOKEN=your_bot_token_here
```

For production deployment, add the secret using Wrangler:

```bash
wrangler secret put DISCORD_BOT_TOKEN
```

### 5. Create a Discord Source

You can create a source by directly inserting into the database or via the UI (when implemented):

```sql
INSERT INTO sources (name, type, description, bucket, url, createdAt, updatedAt)
VALUES (
  'Discord #general',
  'discord',
  '{"guildID": "YOUR_GUILD_ID", "channelID": "YOUR_CHANNEL_ID"}',
  'discord/',
  'https://discord.com/channels/YOUR_GUILD_ID/YOUR_CHANNEL_ID',
  datetime('now'),
  datetime('now')
);
```

## Usage

### Automatic Ingestion

The cron job runs every 6 hours (configured in `wrangler.jsonc`):

```json
"triggers": {
  "crons": ["0 */6 * * *"]
}
```

To change the frequency, update the cron expression:

- `0 */1 * * *` - Every hour
- `*/30 * * * *` - Every 30 minutes
- `0 0 * * *` - Daily at midnight

### Manual Ingestion

Trigger ingestion manually by visiting:

```
https://your-worker-url.workers.dev/ingest/discord
```

Or locally:

```
http://localhost:8787/ingest/discord
```

## How It Works

1. **Fetch Messages**: The ingestor queries the Discord API for messages in the configured channel
2. **Incremental Updates**: Only fetches messages newer than the last ingested message
3. **Store Artifacts**: Messages are stored in R2 bucket at `discord/{guildID}/{channelID}/{timestamp}/`
4. **Multiple Formats**: Stores both JSON (structured) and TXT (readable) formats
5. **Metadata**: Includes message count, timestamp, and ID ranges for tracking

## Bucket Structure

```
discord/
  {guildID}/
    {channelID}/
      {timestamp}/
        messages.json       # Structured message data
        messages.txt        # Human-readable format
        metadata.json       # Ingestion metadata
```

## Limitations

- Maximum 100 messages per API request (handled with pagination)
- Rate limits apply per Discord's API guidelines
- Bot must have proper permissions in the channel
- Historical messages: on first run, fetches up to the API limit

## Troubleshooting

### Bot not seeing messages

Ensure the bot has:

- "Read Messages/View Channels" permission
- "Read Message History" permission
- Message Content Intent enabled in the developer portal

### No messages ingested

Check that:

- The channel ID and guild ID are correct
- The bot is a member of the server
- There are new messages since the last ingestion

### API errors

Check logs for specific error messages. Common issues:

- Invalid bot token
- Missing permissions
- Rate limiting (backed off automatically by Discord)
