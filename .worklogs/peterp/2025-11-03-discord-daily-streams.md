# Discord Daily Streams Implementation

## Problem

The Discord ingestion pipeline needed a way to store messages that:

1. Provides a complete chronological view of channel activity
2. Identifies structured conversations (threads, reply chains) without duplicating content
3. Handles orphaned messages efficiently
4. Avoids complex artifact management during initial development

## Goal

Implement daily stream files as the primary storage mechanism, containing:

- Full content for orphaned messages
- Metadata references for threads and reply chains
- Complete chronological timeline per channel per day

## Solution

### 1. Daily Stream Files (R2 Only)

Created daily stream generation that produces chronological indexes of channel activity.

**Storage path**: `discord/{guildID}/{channelID}/daily/{YYYY-MM-DD}.md`

**Format**:

```markdown
# 2024-10-23

[09:00:00] alice: Quick standalone question here

[09:05:00] → Thread
Messages: 12 | Participants: 4
Duration: 09:05:00 - 10:30:00

[10:45:00] charlie: Thanks for the help!
```

**Content**:

- Thread/reply chain references: Metadata only (message count, participants, duration)
- Orphaned messages: Full content inline
- Chronological ordering by timestamp

**Benefits**:

- Complete timeline of channel activity per day
- Simple storage model (single file per channel per day)
- Identifies conversation structures without creating separate artifacts
- All conversation content accessible in one place

### 2. Conversation Identification

Messages are analyzed to identify conversation structures, but not stored as separate artifacts:

- Threads: Messages with same `thread_id`
- Reply chains: Messages linked via `reply_to_message_id`
- Orphaned: Individual messages without structure

These identifications are used only to create references in daily streams, not to create separate R2 objects or database entries.

### 3. Implementation Details

**Functions added**:

- `createDailyStreams()`: Groups messages by date, creates reference entries for structured conversations
- `generateDailyStreamMarkdown()`: Formats daily stream with metadata-only references and orphaned content

**Functions updated**:

- `processUnprocessedMessages()`: Generates and stores daily streams after identifying conversation structures

**Removed**:

- `storeSplitToR2()`: No longer creating separate thread/reply artifacts
- `generateConversationMarkdown()`: No longer needed
- Database insertions into `conversation_splits` table
- R2 artifact creation for threads and reply chains

## Results

The Discord ingestion pipeline now:

- Creates daily stream files with complete chronological view
- Identifies conversation structures (threads, reply chains) with metadata references
- Includes orphaned message content inline
- Uses simple storage model (one file per channel per day)
- Overwrites daily streams on re-processing (simpler than merging)

## Trade-offs

**Chosen approach**: Daily streams only, no separate conversation artifacts

**Why this approach**:

- Simplifies initial implementation
- All content in one place per day
- Easy to understand and debug
- Conversation structures identified but not separately stored
- Avoids complexity of managing multiple artifact types

**Limitations**:

- Thread/reply content not in separate files (all inline in daily stream as references)
- No database tracking of conversation splits
- Re-processing overwrites entire daily stream
- Cannot query for specific threads/replies without parsing daily streams

**Future considerations**:

- May add separate thread/reply artifacts later if needed
- Could add database tracking for queryability
- Could implement merge strategy for re-processing
- Thread names could be extracted and included in references
