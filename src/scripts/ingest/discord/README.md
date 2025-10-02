# Discord Ingestion System

This system provides API routes for converting Discord message exports to markdown format and managing the ingestion process.

## Overview

The Discord ingestion system consists of API routes that can be called from any client:

1. **Convert API** (`/ingest/discord/convert`) - Converts individual Discord JSON to markdown
2. **Batch API** (`/ingest/discord/batch`) - Processes multiple Discord files in a single request
3. **Upload API** (`/ingest/discord/upload`) - Uploads converted data to R2 storage

## Features

- ✅ **Raw Markdown Generation**: Converts Discord JSON to clean markdown format
- ✅ **Metadata Extraction**: Automatically extracts guild, channel, and timestamp info
- ✅ **Batch Processing**: Handle multiple files at once
- ✅ **Flexible Output**: Custom output directories and naming
- ✅ **R2 Upload Ready**: Framework for uploading to R2 storage
- ✅ **Thread Preservation**: Maintains conversation threading
- ✅ **Reaction Support**: Includes emoji reactions in output

## API Usage

### Single File Conversion

```bash
# Convert Discord messages to markdown
curl -X POST http://localhost:8787/ingest/discord/convert \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [...],
    "guildId": "679514959968993311",
    "channelId": "1307974274145062912",
    "splitConversations": true
  }'
```

### Batch Processing

```bash
# Convert multiple Discord files
curl -X POST http://localhost:8787/ingest/discord/batch \
  -H "Content-Type: application/json" \
  -d '{
    "files": [
      {
        "messages": [...],
        "guildId": "guild1",
        "channelId": "channel1"
      },
      {
        "messages": [...],
        "guildId": "guild2",
        "channelId": "channel2"
      }
    ]
  }'
```

### Upload to R2

```bash
# Upload converted data
curl -X POST http://localhost:8787/ingest/discord/upload \
  -H "Content-Type: application/json" \
  -d '{
    "rawMarkdown": "...",
    "metadata": {
      "guildId": "679514959968993311",
      "channelId": "1307974274145062912",
      "exportTimestamp": "2025-10-02T09-22-37-392Z"
    }
  }'
```

## API Response Format

The API returns structured JSON responses:

### Convert Response

```json
{
  "success": true,
  "rawMarkdown": "2025-05-15 11:54:50 | username: message content...",
  "metadata": {
    "guildId": "679514959968993311",
    "channelId": "1307974274145062912",
    "exportTimestamp": "2025-10-02T09-22-37-392Z",
    "messageCount": 1000,
    "dateRange": {
      "start": "2025-05-15T11:54:50.253000+00:00",
      "end": "2025-09-30T16:23:53.249000+00:00"
    }
  },
  "conversationSplits": [
    {
      "id": "split_2025-05-15_2025-05-15",
      "startTime": "2025-05-15T11:54:50.253000+00:00",
      "endTime": "2025-05-15T13:37:57.080000+00:00",
      "messageCount": 12,
      "participantCount": 3,
      "threadCount": 0,
      "participants": ["user1", "user2", "user3"],
      "splitType": "temporal"
    }
  ]
}
```

## File Naming Convention

The system expects Discord export files to follow this naming pattern:

```
discord_{guildId}_{channelId}_{timestamp}_messages.json
```

Example:

```
discord_679514959968993311_1307974274145062912_2025-10-02T09-22-37-392Z_messages.json
```

## Markdown Format

The generated markdown follows this structure:

```
YYYY-MM-DD HH:MM:SS | username: message content
[reactions: 🙌 3, 🚀 2, 💃 2]
[attachment: filename.png, size, url]
[embed: title, description, url]

> YYYY-MM-DD HH:MM:SS | username: reply message
> [thread: "thread title", 5 messages, 2 members]
```

## Integration with Sources → Artifacts → Subjects

This ingestion system is designed to work with the broader architecture:

1. **Sources**: Discord channels as data sources
2. **Artifacts**: Raw markdown files as immutable artifacts
3. **Subjects**: Extracted topics and conversations (via conversation splitting)

## Advanced Features

### R2 Storage Integration

The system includes hooks for uploading converted files to R2 storage:

```typescript
// R2 upload path structure
discord / { guildId } / { channelId } / { exportTimestamp } / raw.md;
```

### Metadata Extraction

Automatically extracts:

- Guild and channel identifiers
- Export timestamp
- Message count and date range
- File size and processing time

### Error Handling

- Graceful handling of malformed JSON
- Rate limiting for batch operations
- Detailed error reporting
- Resume capability for failed batch operations

## Error Handling

The API includes comprehensive error handling:

- **Validation Errors**: Invalid request format (400)
- **Rate Limiting**: Too many requests (429)
- **Processing Errors**: Conversion failures (500)
- **Detailed Logging**: Request/response logging with timing

## Security Features

- **Input Validation**: Zod schema validation for all requests
- **Rate Limiting**: Per-IP request limiting
- **Request Logging**: Comprehensive audit trail
- **Error Sanitization**: Safe error messages without sensitive data

## Next Steps

1. **R2 Upload Implementation**: Complete the R2 storage integration in upload route
2. **Database Integration**: Store metadata in the database
3. **Authentication**: Add API key or JWT authentication
4. **Monitoring**: Add processing metrics and monitoring
5. **Webhook Support**: Add webhook notifications for completed processing
