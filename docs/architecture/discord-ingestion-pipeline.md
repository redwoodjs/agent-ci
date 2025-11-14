# Discord Ingestion Pipeline

## The Challenges

The architecture addresses several core problems, with the most critical being structuring Discord conversational data for use in an AI retrieval system.

### 1. Data Structure for AI Retrieval

The ingested data serves as the knowledge base for a RAG system, requiring a denormalized structure optimized for semantic search rather than relational queries.

A normalized structure—where channels, threads, and messages are stored as separate documents—is incompatible with a source-agnostic RAG system. The retrieval mechanism uses vector similarity, not relational joins.

The system cannot be expected to understand Discord's specific data model. It would not know, for example, that to understand a Discord thread, it must find the starter message, all thread replies, and potentially related channel messages. Forcing this source-specific logic onto vector search defeats the purpose of a generalized retrieval system. The data must be denormalized before ingestion, structured as "pages" that an AI can consume as a single, pre-joined unit.

### 2. Data Completeness and Consistency

Discord channels and threads are dynamic, with messages being added, edited, or deleted continuously. The system must maintain an up-to-date view of each conversation while tracking changes over time.

*   **Message Lifecycle**: Messages can be edited or deleted after creation. The system must fetch the current state of all messages in a channel or thread, not just individual message events.

*   **Thread Relationships**: Discord threads have a starter message in the parent channel, followed by thread-specific replies. The system must capture both the starter message and all thread messages as a single conversational unit.

*   **Backfill Requirements**: When ingesting historical data, the system must fetch the complete state of channels and threads from the Discord API, organizing messages chronologically into coherent conversation pages.

### 3. Operational Resilience for Backfills

Ingesting the full history of an active Discord server involves fetching thousands of messages across multiple channels and threads. A monolithic backfill script is susceptible to failure from rate limits, network issues, or processing bugs. Without resumability, any failure requires restarting the entire job.

### 4. Channel vs. Thread Organization

Discord has two primary conversational contexts:

*   **Channels**: Top-level conversations where messages appear in a linear timeline. Threads can be created from channel messages.

*   **Threads**: Focused sub-conversations that branch from a parent channel message. Thread messages are separate from the channel timeline.

The system must treat both channels and threads as distinct "pages," each containing their complete message history in a format suitable for AI consumption.

## The Architecture

The architecture is a stateful pipeline that uses a denormalized structure and a queue-based system for backfilling. The design centers on "pages" representing complete conversations.

### 1. A Denormalized, "Page-Centric" Storage Model

The data is stored in a denormalized format that represents complete conversations as single documents.

*   **Channel Pages**: Each channel maintains a `latest.json` file containing all non-thread messages in chronological order. This represents the main channel conversation.

*   **Thread Pages**: Each thread maintains its own `latest.json` file containing the starter message followed by all thread replies in chronological order. This represents the complete thread conversation.

*   **Embedded Messages**: All messages within a page are embedded directly in the parent entity's file, creating a single document that represents the entire conversation.

*   **History Diffs**: Versioning is handled by storing diffs. For each channel or thread, a `history/` subdirectory is maintained. When an update occurs, the system generates a JSON diff of the changes and stores it as a timestamped file, creating an audit trail.

### 2. A "Latest State" Ingestion Model

The system fetches the full, current state of each channel or thread from the Discord API when processing.

When triggered to process a channel or thread, the system makes API calls to fetch all messages in that entity. This data is used to generate the stored artifact, which contains the complete conversation state at the time of processing.

### 3. Queue-Driven Backfill System

The system uses a stateful, queue-driven architecture for backfilling.

*   **State Management**: A Durable Object (`DiscordBackfillStateDO`) tracks the status and progress of each backfill job, persisting pagination cursors from the Discord API. This makes the process resumable.

*   **Two-Tier Queues**: The process splits between two queues. A `DISCORD_SCHEDULER_QUEUE` fetches pages of message IDs and thread IDs from the Discord API, enqueuing jobs for each entity onto a `DISCORD_PROCESSOR_QUEUE`.

*   **Idempotent Processors**: Workers consuming from the `DISCORD_PROCESSOR_QUEUE` are idempotent. Processing a channel or thread multiple times produces the same result, preventing data duplication from retries.

*   **Dead-Letter Queue (DLQ)**: If a job in the `DISCORD_PROCESSOR_QUEUE` fails repeatedly, it is sent to a DLQ. A handler updates the state DO to `paused_on_error`, halting the backfill until the issue is resolved.

### 4. Storage Structure

The R2 storage structure reflects the page-centric model:

```
discord/{guildID}/{channelID}/latest.json
discord/{guildID}/{channelID}/history/{timestamp}.json
discord/{guildID}/{channelID}/threads/{threadID}/latest.json
discord/{guildID}/{channelID}/threads/{threadID}/history/{timestamp}.json
```

Each `latest.json` contains:
- Entity metadata (guild ID, channel ID, thread ID if applicable)
- Complete chronologically-ordered message array
- Each message includes: ID, timestamp, author, content, attachments, reactions

Each history diff file contains:
- Timestamp of the change
- Structured diff showing what changed between previous and current state
- Only created when actual changes are detected

## Backfill Process

The backfill process for a Discord channel proceeds as follows:

1. User initiates backfill via API endpoint, specifying guild ID and channel ID
2. System creates backfill state entry with `pending` status
3. Scheduler queue job starts:
   - Fetches pages of messages from Discord API for the channel
   - Enqueues channel processor job with full message list
   - Discovers threads from messages with thread metadata
   - Enqueues thread processor jobs for each thread
4. Processor queue consumes jobs:
   - Channel processor: Fetches current state, generates `latest.json`, stores diffs
   - Thread processor: Fetches thread messages including starter, generates `latest.json`, stores diffs
5. On completion, backfill state updates to `completed`
6. On error after retries, job moves to DLQ and backfill pauses

The system can be paused and resumed at any point, continuing from the last recorded cursor position.


