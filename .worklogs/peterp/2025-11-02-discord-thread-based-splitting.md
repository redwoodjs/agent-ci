# Discord Thread-Based Message Splitting

## Problem

The `/store` endpoint was processing raw Discord messages by grouping them only by channel and timestamp, storing all messages from a channel into a single artifact. This approach ignored the logical conversation boundaries provided by Discord's thread system and reply chains.

## Goal

Rework the `/store` endpoint to split messages into logical conversation units based on:

1. Discord threads (`thread_id`)
2. Reply chains (`reply_to_message_id`)
3. Individual orphaned messages

## Approach

### Attempt 1: Understanding the Current System

Examined the existing pipeline:

- `fetch.ts` - Fetches messages from Discord API and stores in `raw_discord_messages` table
- `process.ts` - Groups messages by channel/guild and stores to R2 bucket
- Database already captures `thread_id` and `reply_to_message_id` fields
- Existing code had a `split-conversations.ts` that implemented temporal splitting

Finding: The infrastructure was already in place to capture thread and reply metadata, but the store stage wasn't using it.

### Attempt 2: Architecture Documentation First

Updated `docs/architecture/discord-ingestion-pipeline.md` to reflect the new design:

- Three-tier splitting strategy (threads → reply chains → orphaned)
- New output format using markdown with `>` prefixes for threading
- `conversation_splits` table instead of generic artifacts
- Hierarchical splitting logic documentation

Decision: Document the desired behavior before implementing to ensure clarity on the approach.

### Attempt 3: Storage Strategy Evolution

Initially created `conversation_splits` table migration to track split metadata in the database.

Finding 1: User suggested storing conversation splits entirely in R2 to simplify.

Decision 1: Removed `conversation_splits` table, stored everything in R2 `metadata.json`.

Finding 2: User clarified need for Durable Object storage for queryability.

Decision 2: Implement dual-storage approach:

- **Durable Object database**: `conversation_splits` table for queryable metadata (splitType, timestamps, threadID, bucketPath)
- **R2 storage**: Full markdown content and complete metadata JSON
- Benefits: Queryability + complete content preservation

### Current Solution

Rewrote `src/app/ingestors/discord/process.ts` with hierarchical splitting logic:

1. **Thread-based splits** (Priority 1)

   - `groupMessagesByThread()` groups all messages with same `thread_id`
   - Each unique thread becomes one conversation split
   - Most explicit conversation boundary

2. **Reply chain splits** (Priority 2)

   - `buildReplyChains()` builds message relationship graph using `reply_to_message_id`
   - `findRootMessage()` recursively finds the root of each reply tree
   - Each root message + all its replies forms one split

3. **Orphaned messages** (Priority 3)

   - Messages without `thread_id` or `reply_to_message_id`
   - Each becomes an individual split
   - Future work: temporal gap detection to group related orphaned messages

4. **Markdown generation**

   - `generateConversationMarkdown()` creates threaded markdown
   - Root messages have no indent
   - Replies use `>` prefix (one per nesting level)
   - Format: `[timestamp] username: content`

5. **Dual-storage architecture**

   - **Durable Object**: `conversation_splits` table stores queryable metadata
     - Fields: guildID, channelID, splitType, threadID, timestamps, counts, bucketPath
     - Enables efficient querying and filtering
   - **R2 storage**: Full content and complete metadata
     - Path: `discord/{guildID}/{channelID}/{timestamp}/split-{N}/`
     - Files: `conversation.md` and `metadata.json`
     - Complete participant lists and full message content

6. **Route response**
   - Updated `/store` endpoint to return `ProcessingResult`
   - Includes `splitsByType` breakdown showing counts by type
   - Message includes split counts in human-readable format

## Implementation Details

The core splitting logic in `createConversationSplits()`:

1. Process thread-based messages first (explicit boundaries)
2. Track processed message IDs
3. From remaining messages, separate those with replies vs orphaned
4. Build reply chains from messages with `reply_to_message_id`
5. Create individual splits for orphaned messages

The markdown generation preserves conversation structure:

- Root messages appear at start of line
- Direct replies prefixed with `>`
- Nested replies get multiple `>` prefixes
- Chronological ordering within each conversation unit

## Results

The `/store` endpoint now:

- Splits messages into logical conversation units
- Preserves Discord's thread structure
- Maintains reply chain context across temporal gaps
- Stores metadata in Durable Object database for queryability
- Stores full content in R2 for completeness
- Returns detailed breakdown: `{ thread: X, reply_chain: Y, orphaned: Z }`
- Enables both efficient querying (DB) and complete archival (R2)

## Future Considerations

1. Temporal gap detection for orphaned messages
2. Cross-thread relationship detection (same participants, temporal proximity)
3. Thread merging logic for related conversations
