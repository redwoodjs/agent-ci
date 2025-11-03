# Discord Daily Streams Implementation

## Problem

The Discord ingestion pipeline was splitting messages into conversation units (threads, reply chains, orphaned), but the storage strategy had issues:

1. R2 paths used processing timestamps, causing duplicates on re-processing
2. No way to view complete chronological channel activity without reconstructing from separate artifacts
3. Orphaned messages created individual R2 artifacts, which was inefficient
4. No index structure for navigating channel history

## Goal

Implement stable R2 storage paths and add daily stream files that provide chronological indexes of channel activity with references to structured conversations.

## Solution

### 1. Stable R2 Paths

Changed from timestamp-based paths to identifier-based paths:

- Threads: `discord/{guildID}/{channelID}/threads/{threadID}/`
- Reply chains: `discord/{guildID}/{channelID}/replies/{rootMessageID}/`
- Daily streams: `discord/{guildID}/{channelID}/daily/{YYYY-MM-DD}.md`

This prevents duplicate artifacts when re-processing messages and enables direct access by identifier.

### 2. Daily Stream Files

Added daily stream generation that creates chronological indexes of channel activity:

**Format**:

```markdown
# 2024-10-23

[09:00:00] alice: Quick standalone question here

[09:05:00] → Thread
Messages: 12 | Participants: 4
Duration: 09:05:00 - 10:30:00
Path: discord/guild123/channel456/threads/thread789/

[10:45:00] charlie: Thanks for the help!
```

**Content**:

- Thread/reply chain references: Metadata only (message count, participants, duration, path)
- Orphaned messages: Full content inline
- Chronological ordering by timestamp

**Benefits**:

- Complete timeline of channel activity
- No content duplication (structured conversations stored once, referenced)
- Navigable index without reading individual artifacts
- Supports activity pattern analysis

### 3. Orphaned Message Handling

Changed orphaned messages to appear only in daily streams:

- No separate R2 artifacts for orphaned messages
- Full content included in daily stream
- Not tracked in `conversation_splits` database table
- Reduces storage overhead and improves clarity

### 4. Implementation Details

**Updated functions**:

- `storeSplitToR2()`: Changed to use stable paths based on threadID/rootMessageID
- `createDailyStreams()`: Groups messages by date, creates reference entries for structured conversations
- `generateDailyStreamMarkdown()`: Formats daily stream with metadata-only references and orphaned content
- `processUnprocessedMessages()`: Generates and stores daily streams after creating splits

**Database impact**:

- `conversation_splits` table now only stores threads and reply chains
- `splitType` field excludes "orphaned" (appears only in counts)

### 5. Architecture Documentation

Updated `docs/architecture/discord-ingestion-pipeline.md`:

- Three-layer storage architecture section (database, artifacts, daily streams)
- New R2 storage structure with stable paths
- Daily stream format examples
- Updated conversation splitting strategy
- Revised design rationale

## Results

The Discord ingestion pipeline now:

- Uses stable, deterministic R2 paths (no duplicates on re-processing)
- Provides complete chronological channel indexes via daily streams
- Stores structured conversations once with references
- Includes orphaned messages inline in daily streams
- Enables both structured conversation access and timeline navigation
- Supports idempotent re-processing

## Trade-offs

**Chosen approach**: Daily streams with references to structured conversations

**Alternatives considered**:

1. Time-based windows only (would split conversations across boundaries)
2. Full duplication (would double storage, create consistency issues)
3. Durable Object only storage (would require dynamic view generation)

**Benefits of chosen approach**:

- Semantic coherence preserved (threads/replies stay intact)
- No content duplication (structured conversations stored once)
- Complete chronological access (daily streams)
- Stable paths enable direct artifact access
- Queryable metadata in database for structured conversations

**Limitations**:

- Daily streams overwritten completely on re-processing (future: merge new entries)
- Thread names not currently included in references (future: extract from Discord)
