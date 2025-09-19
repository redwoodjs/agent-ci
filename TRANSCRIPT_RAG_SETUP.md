# Transcript RAG Setup with Cloudflare AutoRAG

This document explains how to set up the AI-powered transcript search using Cloudflare AutoRAG.

## Overview

The system integrates with Cloudflare AutoRAG to provide:
- **Semantic search** through meeting transcripts
- **AI-powered Q&A** based on transcript content
- **Automatic indexing** of new transcripts in R2 storage
- **Multi-tenancy** support using container-based filtering

## Setup Steps

### 1. Wrangler Configuration

The AutoRAG binding is already configured in `wrangler.jsonc`:

```json
{
  "ai": {
    "binding": "AI"
  },
  "r2_buckets": [
    {
      "binding": "CONTEXT_STREAM",
      "bucket_name": "context-stream"
    }
  ]
}
```

### 2. Create AutoRAG Instance

1. **Login to Cloudflare Dashboard**
2. **Navigate to Workers AI > AutoRAG**
3. **Create new instance** named: `machinen-transcripts`
4. **Configure data source**:
   - Type: R2 Bucket
   - Bucket: `context-stream`
   - Prefix: (leave empty to index all containers)

### 3. No Environment Variables Needed!

Thanks to Workers bindings, you don't need API tokens or account IDs in your `.env` file. The system uses:
- **Workers AI binding** (`env.AI`) for AutoRAG operations
- **R2 binding** (`env.CONTEXT_STREAM`) for transcript storage
- **Native integration** with your Cloudflare account

### 4. Initialize and Test

1. Generate some transcripts: Click **"Generate from Git History"**
2. Test the connection: Click **"Initialize AI Search"**
3. Try searching: Enter queries like "OpenCode integration"

## Features

### Transcript Generation
- Generate realistic meeting transcripts from git commit history
- Transcripts include speaker attribution, timestamps, and confidence scores
- Automatically saved to R2 storage

### AI Search Interface
- **Semantic Search**: Find relevant transcript segments using natural language
- **AI Q&A**: Ask specific questions and get context-aware answers
- **Source Attribution**: See which transcript segments were used for answers
- **Real-time Status**: Monitor indexing progress and system status

### System Architecture

```
Git History → Transcript Generator → R2 Storage
                                       ↓
                               Cloudflare AutoRAG
                                       ↓
                              Search Interface ← User Queries
```

## AutoRAG Configuration

The system automatically configures AutoRAG with:

- **Data Source**: R2 bucket with container-specific prefixes
- **Chunking**: Semantic chunking with 512 tokens, 50 token overlap
- **Embedding Model**: `@cf/baai/bge-large-en-v1.5`
- **Generation Model**: `@cf/meta/llama-3.1-8b-instruct`
- **Metadata Filtering**: Container-based isolation
- **System Prompt**: Optimized for meeting transcript Q&A

## Usage Examples

### Sample Queries

**Search Queries**:
- "OpenCode integration"
- "chat streaming issues"
- "authentication problems"
- "task management discussion"

**Q&A Questions**:
- "What decisions were made about the OpenCode integration?"
- "How did the team solve the chat streaming problems?"
- "What are the main features discussed in recent meetings?"
- "Who worked on the authentication system?"

### API Endpoints

The system provides these server actions:

- `generateTranscriptsFromGitHistory(containerId)` - Generate sample transcripts
- `initializeTranscriptRAG(containerId)` - Set up AutoRAG instance
- `searchTranscripts(query, containerId)` - Semantic search
- `askTranscriptQuestion(question, containerId)` - AI Q&A
- `getRAGStatus(containerId)` - Check indexing status

## Troubleshooting

### Common Issues

1. **"Initialize AI Search" fails**
   - Check Cloudflare API token permissions
   - Verify account ID is correct
   - Ensure R2 bucket exists and is accessible

2. **Search returns no results**
   - Wait for indexing to complete (check status)
   - Verify transcripts exist in R2
   - Try different search terms

3. **AI answers are generic**
   - Make sure indexing is complete
   - Try more specific questions
   - Check if transcripts contain relevant content

### Monitoring

Use `getRAGStatus()` to monitor:
- Indexing progress (0-100%)
- System status (indexing, ready, error)
- Error messages if any

## Cost Considerations

AutoRAG pricing is based on:
- Document indexing (per document)
- Search queries (per query)
- AI generation (per token)

See [Cloudflare AutoRAG pricing](https://developers.cloudflare.com/autorag/platform/limits-pricing/) for current rates.

## Development Notes

### File Structure

```
src/app/pages/transcript/
├── actions.ts                           # Server actions for RAG operations
├── components/
│   ├── GenerateTranscriptsButton.tsx    # Generate from git history
│   └── TranscriptSearchInterface.tsx    # Main search UI
├── generate-transcripts.ts              # Commit history → transcript conversion
└── TranscriptPage.tsx                   # Main transcript page

src/app/services/
└── transcriptRAG.ts                     # AutoRAG service wrapper
```

### Extension Ideas

- **Real-time transcript ingestion** from actual meetings
- **Multi-language support** with different embedding models
- **Advanced filtering** by date, participants, or topics
- **Export functionality** for search results
- **Integration with chat system** for context-aware responses