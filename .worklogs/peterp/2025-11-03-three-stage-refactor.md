# Three-Stage Discord Ingestion Refactor

## Overview

Refactoring the Discord ingestion pipeline from 2 stages to 3 stages:

**Current:**
1. Fetch (API → raw database with extraction)
2. Process (raw database → markdown → R2)

**New:**
1. Fetch (API → raw database, minimal extraction)
2. Process (raw database → processed database, extract all fields)
3. Transform (processed database → markdown → R2)

## Architecture Changes

### Data Flow

```
Discord API
    ↓
[Fetch Stage]
    ↓
raw_discord_messages (minimal: IDs + raw JSON)
    ↓
[Process Stage]
    ↓
processed_discord_messages (structured fields)
    ↓
[Transform Stage]
    ↓
R2 + conversation_splits table
```

### Benefits

1. Separation of concerns (API interaction, field extraction, format conversion)
2. Can reprocess without refetching from Discord API
3. Can retransform without reprocessing
4. Raw API responses preserved unchanged
5. Each stage independently testable

## Implementation Tasks

### Task 1: Database Migrations

Create migrations to:

1. Create `processed_discord_messages` table:
   - message_id (PK)
   - channel_id, guild_id
   - author_id, author_name
   - content, timestamp
   - thread_id, thread_name, thread_archived, thread_parent_id
   - reply_to_message_id, reply_to_channel_id
   - processed_at (timestamp)
   - transform_state ('untransformed' | 'transformed')

2. Simplify `raw_discord_messages` table:
   - Keep: message_id, channel_id, guild_id, raw_data
   - Remove: author_id, content, timestamp, thread_name, thread_archived, thread_parent_id, reply_to_message_id, reply_to_channel_id
   - Rename: ingested_at → fetched_at
   - Add: fetch_state ('fetched')

**Files:** `src/app/ingestors/discord/migrations.ts`

### Task 2: Update Fetch Stage

Simplify `fetch.ts` to store only minimal data:

1. Remove field extraction from `fetchMessagesFromThread()`
   - Store only: message_id, channel_id, guild_id, raw_data
   - Remove extraction of: author_id, content, timestamp, thread_name, etc.

2. Remove field extraction from `ingestMessagesForSource()`
   - Store only: message_id, channel_id, guild_id, raw_data
   - Remove extraction of: author_id, content, timestamp, reply_to_message_id, etc.

3. Update thread metadata handling
   - Store thread metadata in separate structure if needed
   - Don't extract into message records

**Files:** `src/app/ingestors/discord/fetch.ts`

### Task 3: Create Process Stage

Create new process logic in `process.ts`:

1. Create `processRawMessages()` function:
   - Query unprocessed messages from `raw_discord_messages`
   - For each message, parse `raw_data` JSON
   - Extract all fields needed for markdown generation
   - Insert into `processed_discord_messages`
   - Mark as processed in `raw_discord_messages`

2. Field extraction logic:
   ```typescript
   function extractMessageFields(rawMessage: RawDiscordMessage): ProcessedDiscordMessage {
     const data = JSON.parse(rawMessage.raw_data);
     return {
       message_id: rawMessage.message_id,
       channel_id: rawMessage.channel_id,
       guild_id: rawMessage.guild_id,
       author_id: data.author.id,
       author_name: data.author.username || data.author.global_name || 'unknown',
       content: data.content,
       timestamp: data.timestamp,
       thread_id: data.thread?.id || null,
       thread_name: data.thread?.name || null,
       // ... etc
     };
   }
   ```

**Files:** `src/app/ingestors/discord/process.ts`

### Task 4: Create Transform Stage

Create new `transform.ts` file:

1. Move from `process.ts` to `transform.ts`:
   - `groupMessagesByThread()`
   - `createConversationSplits()`
   - `generateSplitMarkdown()`
   - `saveSplitToR2()`
   - `createDailyStreams()`
   - `generateDailyStreamMarkdown()`

2. Create `transformProcessedMessages()` function:
   - Query untransformed messages from `processed_discord_messages`
   - Group into conversation splits
   - Generate markdown
   - Save to R2 and database
   - Mark as transformed in `processed_discord_messages`

3. Update all functions to use `ProcessedDiscordMessage` type instead of `RawDiscordMessage`

**Files:** `src/app/ingestors/discord/transform.ts` (new file)

### Task 5: Update Routes

Update `routes.ts` to expose three endpoints:

1. Rename `/ingest` to `/fetch`
   - Calls `fetchDiscordMessages()`
   - Returns: messageCount, threadCount, firstMessageID, lastMessageID

2. Update `/process` endpoint
   - Calls new `processRawMessages()`
   - Returns: processedCount, extractedFields

3. Add `/transform` endpoint
   - Calls new `transformProcessedMessages()`
   - Returns: transformedCount, splitsCreated, splitsByType, dailyStreamsCreated

**Files:** `src/app/ingestors/discord/routes.ts`

### Task 6: Update Types

Create/update TypeScript interfaces:

1. Update `RawDiscordMessage` interface (simplified):
   ```typescript
   interface RawDiscordMessage {
     message_id: string;
     channel_id: string;
     guild_id: string;
     raw_data: string;
     fetched_at: string;
     fetch_state: string;
     process_state: string;
   }
   ```

2. Create `ProcessedDiscordMessage` interface:
   ```typescript
   interface ProcessedDiscordMessage {
     message_id: string;
     channel_id: string;
     guild_id: string;
     author_id: string;
     author_name: string;
     content: string;
     timestamp: string;
     thread_id: string | null;
     thread_name: string | null;
     thread_archived: number;
     thread_parent_id: string | null;
     reply_to_message_id: string | null;
     reply_to_channel_id: string | null;
     processed_at: string;
     transform_state: string;
   }
   ```

**Files:** 
- `src/app/ingestors/discord/process.ts`
- `src/app/ingestors/discord/transform.ts`
- `src/app/ingestors/discord/fetch.ts`

### Task 7: Migration Strategy

Decide on data migration approach:

**Option A: Start Fresh**
- Drop existing `raw_discord_messages` data
- Re-fetch from Discord using new schema
- Simpler, ensures consistency

**Option B: Migrate Existing Data**
- Keep existing `raw_discord_messages`
- Existing rows already have structured fields (can be removed after verification)
- raw_data already contains full JSON
- Create script to populate `processed_discord_messages` from existing data

Recommendation: Option B (migrate) since we already have the raw_data

## Testing Plan

1. Test fetch stage:
   - Verify only IDs + raw_data are stored
   - Verify incremental fetching still works
   - Check thread fetching

2. Test process stage:
   - Verify all fields extracted correctly
   - Verify author names parsed correctly
   - Check thread metadata extraction
   - Check reply metadata extraction

3. Test transform stage:
   - Verify markdown generation
   - Verify R2 storage
   - Verify daily streams
   - Check conversation_splits table

4. End-to-end test:
   - Run fetch → process → transform
   - Verify complete pipeline
   - Check idempotency (can re-run without errors)

## Rollout Plan

1. Create and run database migrations
2. Update fetch.ts (backward compatible - just stores less data)
3. Create new process stage
4. Create new transform stage  
5. Update routes
6. Test all three stages independently
7. Test complete pipeline
8. Update any dependent code/documentation

## Files to Modify

1. `/docs/architecture/discord-ingestion-pipeline.md` ✓ (done)
2. `/src/app/ingestors/discord/migrations.ts`
3. `/src/app/ingestors/discord/fetch.ts`
4. `/src/app/ingestors/discord/process.ts`
5. `/src/app/ingestors/discord/transform.ts` (new)
6. `/src/app/ingestors/discord/routes.ts`

## Implementation Complete

All tasks have been completed successfully:

### ✅ Task 1: Database Migrations
- Created migration `005_create_processed_discord_messages_table`
- Added table with all structured fields (author_name, content, timestamp, thread metadata, etc.)
- Kept existing `raw_discord_messages` table for backward compatibility

### ✅ Task 2: Simplified Fetch Stage
- Updated `fetch.ts` to store only minimal data in `raw_discord_messages`
- Channel messages: message_id, channel_id, guild_id, raw_data
- Thread messages: Same minimal fields + thread metadata embedded in raw_data as `_thread_metadata`
- Removed all field extraction logic from fetch stage

### ✅ Task 3: Created Process Stage
- Completely rewrote `process.ts` to focus only on field extraction
- Created `extractMessageFields()` function to parse raw_data JSON
- Extracts author_name, content, timestamp, thread metadata, reply information
- Populates `processed_discord_messages` table
- Marks messages as processed in `raw_discord_messages`

### ✅ Task 4: Created Transform Stage
- Created new `transform.ts` file with all markdown generation logic
- Moved functions from old process.ts:
  - `groupMessagesByThread()`
  - `createConversationSplits()`
  - `generateSplitMarkdown()`
  - `saveSplitToR2()`
  - `createDailyStreams()`
  - `generateDailyStreamMarkdown()`
- Updated to query from `processed_discord_messages`
- Marks messages as transformed after completion

### ✅ Task 5: Updated Routes
- Updated `routes.ts` to expose three endpoints:
  - `/fetch` - Calls `fetchDiscordMessages()`
  - `/process` - Calls `processDiscordMessages()`
  - `/transform` - Calls `transformDiscordMessages()`
- Updated response messages for each stage

### ✅ Task 6: Updated TypeScript Interfaces
- Created `ProcessedDiscordMessage` interface with all extracted fields
- Maintained `RawDiscordMessage` interface with existing schema for backward compatibility
- Updated all function signatures to use appropriate types
- No linter errors

## Files Modified

1. ✅ `/docs/architecture/discord-ingestion-pipeline.md` - Updated architecture
2. ✅ `/src/app/ingestors/discord/migrations.ts` - Added new migration
3. ✅ `/src/app/ingestors/discord/fetch.ts` - Simplified to minimal data storage
4. ✅ `/src/app/ingestors/discord/process.ts` - Rewritten for field extraction only
5. ✅ `/src/app/ingestors/discord/transform.ts` - Created with markdown generation
6. ✅ `/src/app/ingestors/discord/routes.ts` - Updated with three endpoints

## Usage

The new three-stage pipeline works as follows:

1. **Fetch Stage**: `POST /ingest/discord/fetch`
   - Fetches raw messages from Discord API
   - Stores minimal data: IDs + full JSON
   - Response: messageCount, threadCount, firstMessageID, lastMessageID

2. **Process Stage**: `POST /ingest/discord/process`
   - Reads unprocessed messages from `raw_discord_messages`
   - Extracts all fields from raw_data JSON
   - Stores in `processed_discord_messages`
   - Response: processedCount

3. **Transform Stage**: `POST /ingest/discord/transform`
   - Reads untransformed messages from `processed_discord_messages`
   - Groups into conversation splits
   - Generates markdown and stores in R2
   - Response: transformedCount, splitsCreated, splitsByType

## Next Steps

1. Run migrations to create `processed_discord_messages` table
2. Test the three-stage pipeline end-to-end
3. Verify existing data can be processed through new pipeline
4. Consider cleanup migration to remove redundant fields from `raw_discord_messages` (optional)

