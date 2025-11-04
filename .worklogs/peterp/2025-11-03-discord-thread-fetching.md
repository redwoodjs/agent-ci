# Discord Thread Fetching

## Problem

The current Discord ingestion only fetches messages from the main channel using the `/channels/{channelID}/messages` endpoint. Discord threads are sub-channels with their own IDs, and messages within threads are not returned by the main channel endpoint. This means we're missing all conversation data from threads.

## Understanding Discord Threads

Discord has two concepts:

1. Messages posted directly to a channel
2. Messages posted within threads (which are sub-channels)

Thread types:

- **Public threads**: Created from a message or manually, visible to all channel members
- **Private threads**: Visible only to invited members
- **Archived threads**: Threads that have been inactive and archived

## Discord API Endpoints

To fetch all messages including threads:

1. `GET /channels/{channelID}/threads/active` - Lists currently active threads
2. `GET /channels/{channelID}/threads/archived/public` - Lists archived public threads
3. `GET /channels/{channelID}/threads/archived/private` - Lists archived private threads (requires additional permissions)
4. `GET /channels/{threadID}/messages` - Fetches messages from a specific thread (using thread ID as channel ID)

Thread listing returns:

```json
{
  "threads": [
    {
      "id": "thread_id",
      "name": "Thread name",
      "type": 11, // GUILD_PUBLIC_THREAD
      "guild_id": "guild_id",
      "parent_id": "parent_channel_id",
      "owner_id": "creator_user_id",
      "message_count": 5,
      "member_count": 3,
      "archived": false,
      "archive_timestamp": "2024-11-03T12:00:00.000000+00:00",
      "auto_archive_duration": 1440
    }
  ],
  "has_more": false
}
```

## Implementation Approach

### Attempt 1: Update Architecture Documentation

Document the thread fetching requirements in `discord-ingestion-pipeline.md`:

- Add thread listing to the ingest stage
- Document thread metadata storage
- Update database schema to include thread metadata fields

### Attempt 2: Implement Thread Listing

Add functions to `fetch.ts`:

1. `fetchActiveThreads(channelID, botToken)` - Fetch active threads
2. `fetchArchivedThreads(channelID, botToken, type)` - Fetch archived threads with pagination
3. Update `fetchDiscordMessages()` to enumerate threads and fetch messages from each

### Attempt 3: Store Thread Metadata

Update `raw_discord_messages` table to include:

- `thread_name` - Thread name from metadata
- `thread_archived` - Whether thread is archived
- `thread_parent_id` - Parent channel ID
- Update any existing `thread_id` handling to use this richer metadata

### Attempt 4: Handle Thread Pagination

Archived thread endpoints support pagination with `before` parameter (timestamp-based):

- Parse `has_more` flag from response
- Use oldest thread's `archive_timestamp` as cursor for next page
- Implement pagination loop similar to message fetching

## Expected Changes

Files to modify:

1. `/docs/architecture/discord-ingestion-pipeline.md` - Document thread fetching
2. `/src/app/ingestors/discord/fetch.ts` - Add thread listing and fetching logic
3. `/src/app/ingestors/discord/migrations.ts` - Update schema if needed
4. `/src/app/ingestors/discord/db.ts` - Update types if needed

## Implementation Summary

### Changes Made

1. **Architecture Documentation** (`discord-ingestion-pipeline.md`):

   - Added thread discovery endpoints to API interaction section
   - Updated message storage schema with thread metadata fields
   - Updated database schema documentation

2. **Database Migration** (`migrations.ts`):

   - Added migration `003_add_thread_metadata_fields`
   - New columns: `thread_name`, `thread_archived`, `thread_parent_id`

3. **Fetch Implementation** (`fetch.ts`):
   - Added TypeScript interfaces: `DiscordThread`, `ThreadListResponse`
   - Added `fetchActiveThreads()` - Fetches active threads from a channel
   - Added `fetchArchivedThreads()` - Fetches archived threads with pagination
   - Added `getAllThreads()` - Combines active and archived thread fetching
   - Added `fetchMessagesFromThread()` - Fetches messages from a specific thread with metadata
   - Updated `ingestMessagesForSource()` - Now fetches from both channel and all threads

### How It Works

The ingestion flow now:

1. Fetches messages from the main channel (as before)
2. Lists all threads (active and archived) in the channel
3. For each thread, fetches messages using the thread ID as a channel ID
4. Stores thread metadata (name, archived status, parent channel) with each message

Thread messages are stored with:

- `channel_id`: The thread ID (since threads are sub-channels)
- `thread_id`: Same as channel_id for thread messages
- `thread_name`: Thread name from Discord
- `thread_archived`: 0 or 1
- `thread_parent_id`: Parent channel ID

This allows the process stage to properly group messages by thread.

## Testing

After implementation:

1. Ingest a channel that has active threads
2. Verify thread messages appear in `raw_discord_messages`
3. Verify thread metadata is captured
4. Run process stage and verify threads are grouped correctly
5. Check daily streams include thread references

## Currently Accepted Solution

Thread fetching is now fully integrated into the Discord ingestion pipeline. The implementation:

- Fetches all thread types (active, public archived, private archived)
- Handles pagination for archived threads
- Stores thread metadata for proper organization
- Maintains incremental ingestion for both channels and threads
- Respects Discord rate limits with appropriate delays

## Additional Changes: Thread Storage Structure

After implementing thread fetching, updated the process stage to properly save threads as separate files:

### Changes to `process.ts`:

1. **Added `generateSplitMarkdown()`** - Generates markdown for conversation splits with proper reply threading using `>` prefixes

2. **Added `saveSplitToR2()`** - Saves thread and reply chain splits to R2:

   - Threads: `discord/{guildID}/{channelID}/threads/{threadID}/`
   - Reply chains: `discord/{guildID}/{channelID}/replies/{rootMessageID}/`
   - Each split includes `conversation.md` and `metadata.json`

3. **Updated `createDailyStreams()`** - Now accepts `splitPaths` map to include file paths in daily stream references

4. **Updated `generateDailyStreamMarkdown()`** - Daily streams now show:

   - Thread name in header (e.g., `→ Thread: Bug Discussion`)
   - Path to saved split file
   - Metadata (messages, participants, duration)
   - Full content only for orphaned messages

5. **Updated `processUnprocessedMessages()`**:
   - Groups messages by parent channel (uses `thread_parent_id` for thread messages)
   - Saves thread and reply chain splits to R2 before creating daily streams
   - Daily streams reference saved splits instead of duplicating content
   - Updates processed state by message ID (works for both channel and thread messages)

### Result

Threads are now properly saved as separate conversation files and referenced in daily streams, providing:

- Organized thread conversations with full context
- Chronological daily index without content duplication
- Easy navigation between daily timeline and detailed thread content

## Additional Changes: Database Storage and Simplified Processing

User reported empty conversations, so added database tracking and simplified the splitting logic:

### Changes Made:

1. **Added `conversation_splits` table to Durable Object** (migration `004_create_conversation_splits_table`):

   - Stores split metadata in queryable database
   - Fields: guildID, channelID, splitType, threadID, threadName, timestamps, counts, bucketPath
   - Enables debugging and querying of created splits

2. **Updated `saveSplitToR2()`** to insert records into `conversation_splits` table after saving to R2

3. **Removed reply chain processing** to simplify and focus on threads:

   - Removed `buildReplyChains()` function
   - Changed `ConversationSplit` type to only support "thread" | "orphaned"
   - All non-thread messages are now treated as orphaned
   - Simplified daily stream generation

4. **Added extensive logging** to debug empty conversations:
   - Logs message counts at each stage
   - Logs thread discovery and grouping
   - Logs markdown generation size
   - Logs R2 save operations

### Benefits:

- **Queryability**: Can query all splits from database to see what was created
- **Debugging**: Logs show exactly what's happening at each step
- **Simplicity**: Focus on threads (the main feature) without reply chain complexity
- **Consistency**: Database and R2 stay in sync for each split
