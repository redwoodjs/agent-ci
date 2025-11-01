# Discord Subject Extraction Implementation

Date: 2025-10-23

## Problem

Discord messages were being stored in the database but not grouped by subject. The system needed a way to:

1. Split large collections of Discord messages into logical conversation units
2. Extract meaningful subjects from those conversations using an LLM
3. Maintain thread relationships and reply chains

## Solution

Implemented a three-stage pipeline for Discord conversation processing:

### Stage 1: Database Schema Updates

Added `reply_to_message_id` and `reply_to_channel_id` columns to `raw_discord_messages` table to capture Discord's message reference structure for threaded conversations.

Created `conversation_splits` table in the main database to track conversation units with metadata including:

- Temporal boundaries (start/end times)
- Participant and thread counts
- Split type (temporal, thread, or combined)
- Reference to parent artifact

### Stage 2: Conversation Splitting Logic

Implemented `split-conversations.ts` with:

- **Temporal gap detection**: Splits conversations when >4 hours between messages
- **Thread preservation**: Uses `reply_to_message_id` to reconstruct parent-child relationships recursively
- **Markdown generation**: Formats conversations with threaded indentation using `>` prefix for replies
- **R2 storage**: Stores conversation markdown and metadata to bucket

Algorithm flow:

1. Query all processed messages for a Discord artifact
2. Split by temporal gaps (4-hour threshold)
3. Build message lookup table and reconstruct thread hierarchies
4. Generate markdown with proper indentation for nested replies
5. Store to R2 and create conversation_splits records

### Stage 3: LLM-based Subject Extraction

Implemented `extract-subjects.ts` with:

- OpenAI GPT-4o integration for subject analysis
- Custom Discord conversation prompt handling:
  - Multi-participant discussions
  - Thread-based conversations with reply chains
  - Technical discussions vs support requests vs announcements
  - Subject synthesis with facets and aliases
- Subject storage in database linked to artifacts
- JSON output stored to R2 for reference

The prompt instructs the LLM to:

- Extract one dominant subject per conversation
- Use "Gerund + object + context" pattern for titles
- Identify facets (sub-topics) and aliases (variants)
- Map subject mentions to specific line numbers
- Classify conversation type (discussion, support, announcement, feature_request)

### Stage 4: API Endpoints

Added two new endpoints to `routes.ts`:

**POST /ingestors/discord/split-conversations**

- Process all unprocessed artifacts (no params)
- Process specific artifact (?artifactID=123)
- Returns: processed count and errors

**POST /ingestors/discord/extract-subjects**

- Process all unprocessed splits (no params)
- Process specific split (?conversationSplitID=123)
- Process all splits for artifact (?artifactID=123)
- Returns: processed count, created count, and errors

## Files Created/Modified

### Created:

- `src/app/ingestors/discord/prompts.ts` - Discord conversation prompt for LLM
- `src/app/ingestors/discord/split-conversations.ts` - Conversation splitting logic
- `src/app/ingestors/discord/extract-subjects.ts` - Subject extraction with OpenAI

### Modified:

- `src/app/ingestors/discord/migrations.ts` - Added reply fields migration
- `src/app/ingestors/discord/ingest.ts` - Extract reply_to_message_id from API
- `src/app/ingestors/discord/routes.ts` - Added new endpoints
- `src/app/ingestors/discord/README.md` - Documented new pipeline stages
- `src/db/migrations.ts` - Added conversation_splits table
- `docs/architecture/discord-conversation-splitting.md` - Updated with implementation status
- `docs/architecture/discord-markdown-format.md` - Documented actual implementation

## Pipeline Flow

Complete Discord ingestion pipeline:

1. **Ingest** - Fetch from Discord API → raw_discord_messages (Durable Object)
2. **Store** - Create artifacts → R2 bucket + artifacts table
3. **Split** - Temporal/thread-based splitting → conversation_splits table + R2 markdown
4. **Extract** - LLM subject extraction → subjects table + R2 JSON

## Key Design Decisions

### 4-hour temporal gap threshold

Balances between splitting natural conversation breaks and keeping related discussions together.

### Reply chain reconstruction

Uses `reply_to_message_id` instead of just `thread_id` to capture more granular reply relationships beyond formal Discord threads.

### Single subject per conversation

Simplifies initial implementation. Future enhancement: multi-subject detection per conversation.

### OpenAI GPT-4o model

Uses latest model for best subject extraction quality. Temperature set to 0.1 for consistent results.

### Manual trigger endpoints

Conversation splitting and subject extraction are separate, manually-triggered operations rather than automatic post-processing. This provides:

- Control over LLM API usage and costs
- Ability to re-process with different parameters
- Separation of concerns between ingestion and analysis

## Testing Approach

To test the implementation:

```bash
# 1. Ingest messages
curl -X POST http://localhost:8787/ingestors/discord/ingest

# 2. Store as artifacts
curl -X POST http://localhost:8787/ingestors/discord/store

# 3. Split conversations
curl -X POST http://localhost:8787/ingestors/discord/split-conversations

# 4. Extract subjects
curl -X POST http://localhost:8787/ingestors/discord/extract-subjects
```

## Future Enhancements

1. Multi-subject detection per conversation
2. Semantic similarity-based conversation grouping
3. Cross-artifact linking (Discord → GitHub PRs/Issues)
4. Automatic subject categorization by type
5. Participant analysis and tracking
6. Conversation summarization
7. Reaction and attachment processing

## Outcome

The system can now:

- Automatically split Discord message collections into logical conversation units
- Preserve complex thread hierarchies in readable markdown format
- Extract meaningful subjects using LLM analysis
- Store structured data for semantic search and analysis

All linting passes with no errors. Documentation updated to reflect implementation status.
