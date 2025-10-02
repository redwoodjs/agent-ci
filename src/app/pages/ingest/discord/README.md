# Discord Ingestion API

Pure API endpoints for converting Discord message exports to markdown format.

## Endpoints

### POST `/ingest/discord/convert`

Convert a single Discord message export to markdown.

**Request Body:**

```json
{
  "messages": [
    {
      "id": "string",
      "content": "string",
      "timestamp": "string",
      "author": {
        "id": "string",
        "username": "string",
        "global_name": "string"
      },
      "channel_id": "string"
    }
  ],
  "guildId": "string (optional)",
  "channelId": "string (optional)",
  "exportTimestamp": "string (optional)",
  "splitConversations": "boolean (optional, default: false)"
}
```

**Response:**

```json
{
  "success": true,
  "rawMarkdown": "string",
  "metadata": {
    "guildId": "string",
    "channelId": "string",
    "exportTimestamp": "string",
    "messageCount": 1000,
    "dateRange": {
      "start": "2025-05-15T11:54:50.253000+00:00",
      "end": "2025-09-30T16:23:53.249000+00:00"
    }
  },
  "conversationSplits": [
    {
      "id": "string",
      "startTime": "string",
      "endTime": "string",
      "messageCount": 50,
      "participantCount": 5,
      "threadCount": 2,
      "participants": ["user1", "user2"],
      "splitType": "temporal"
    }
  ]
}
```

### POST `/ingest/discord/batch`

Convert multiple Discord message exports in a single request.

**Request Body:**

```json
{
  "files": [
    {
      "messages": [...],
      "guildId": "string",
      "channelId": "string",
      "exportTimestamp": "string",
      "splitConversations": false
    }
  ]
}
```

**Response:**

```json
{
  "success": true,
  "results": [
    {
      "success": true,
      "rawMarkdown": "string",
      "metadata": {...}
    }
  ],
  "summary": {
    "totalFiles": 2,
    "successCount": 2,
    "errorCount": 0
  }
}
```

### POST `/ingest/discord/upload`

Upload converted Discord data to R2 storage.

**Request Body:**

```json
{
  "rawMarkdown": "string",
  "metadata": {
    "guildId": "string",
    "channelId": "string",
    "exportTimestamp": "string"
  },
  "conversationSplits": [...]
}
```

**Response:**

```json
{
  "success": true,
  "message": "Upload simulated successfully",
  "r2Key": "discord/{guildId}/{channelId}/{exportTimestamp}/raw.md"
}
```

## Features

- ✅ **Input Validation**: Zod schema validation for all requests
- ✅ **Rate Limiting**: 10 requests per minute per IP
- ✅ **Request Logging**: Automatic logging of all API calls
- ✅ **Error Handling**: Comprehensive error responses
- ✅ **Conversation Splitting**: Optional conversation chunking
- ✅ **Metadata Extraction**: Automatic extraction of guild/channel info

## Usage Examples

### Convert single Discord export

```bash
curl -X POST http://localhost:8787/ingest/discord/convert \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [...],
    "guildId": "679514959968993311",
    "channelId": "1307974274145062912",
    "splitConversations": true
  }'
```

### Batch convert multiple exports

```bash
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

## Error Responses

All endpoints return consistent error responses:

```json
{
  "success": false,
  "error": "Error message",
  "details": [...] // For validation errors
}
```

**Common Status Codes:**

- `400` - Bad Request (validation errors)
- `429` - Too Many Requests (rate limit exceeded)
- `500` - Internal Server Error
