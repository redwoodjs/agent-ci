# Data Ingestion Pipeline Architecture

## 1. Objective

This document defines the architecture for a robust data ingestion pipeline. The primary goal is to create a standardized process for collecting raw data from various sources, such as Discord, and storing it in a central database before any processing or analysis occurs. This approach ensures that downstream processes, like semantic chunking, operate on complete and consistent datasets.

## 2. Problem Statement

Our current ingestion model processes data directly from source files or API batches. This creates a significant problem when a single logical unit of content, such as a long-running conversation, is split across multiple files or batches. The semantic chunking and linking algorithms cannot function correctly without a complete view of the data, leading to fragmented and contextually incomplete chunks.

To solve this, we need a pipeline that decouples data fetching from data processing by first consolidating all raw data into a central repository.

## 3. Ingestion Pipeline Architecture

The proposed pipeline consists of the following stages:

```
[Source API (e.g., Discord)] -> [1. Raw Ingestion Service] -> [2. Raw Data Store (Database)] -> [3. Staging Service] -> [4. Semantic Processor] -> [5. Processed Data Store]
```

### 3.1. Stage 1: Raw Ingestion Service

- **Responsibility**: Fetch data from source APIs (e.g., Discord API, GitHub API).
- **Process**:
  - The service runs on a schedule or is triggered by an event.
  - It fetches data in batches (e.g., 1000 messages at a time).
  - It performs minimal transformation, primarily to fit the data into a standardized raw schema.
  - It does **not** perform any analysis, chunking, or linking.

### 3.2. Stage 2: Raw Data Store

- **Responsibility**: Store the raw, unprocessed data from all sources.
- **Implementation**: A relational database with tables designed to hold raw source-specific data.

#### Example Data Model: `raw_discord_messages`

```sql
CREATE TABLE raw_discord_messages (
  message_id TEXT PRIMARY KEY, -- Discord's message Snowflake ID
  channel_id TEXT NOT NULL,
  guild_id TEXT,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  thread_id TEXT, -- If the message is in a thread
  raw_data JSONB, -- The original, unmodified JSON from the Discord API
  ingested_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  processed_state TEXT DEFAULT 'unprocessed' -- (e.g., 'unprocessed', 'processing', 'processed')
);
```

### 3.3. Stage 3: Staging Service

- **Responsibility**: Prepare complete datasets for the semantic processor.
- **Process**:
  - When a processing job is initiated (e.g., "process all messages from #general channel for yesterday"), this service queries the `Raw Data Store`.
  - It assembles a complete, ordered set of messages based on the job's parameters. For example, it would fetch all `raw_discord_messages` for a specific `channel_id` within a given timestamp range.
  - It hands this complete dataset to the Semantic Processor.

### 3.4. Stage 4: Semantic Processor

- **Responsibility**: Execute the semantic chunking and linking logic.
- **Process**:
  - This is where the logic from `universal-semantic-chunking.md` and `cross-content-linking.md` is applied.
  - It receives a complete dataset from the Staging Service and is therefore able to correctly identify conversation boundaries, topics, and links without being affected by arbitrary batch sizes.

### 3.5. Stage 5: Processed Data Store

- **Responsibility**: Store the output of the Semantic Processor.
- **Implementation**: The database tables for `SemanticChunk`, `CrossSourceLink`, `ConversationSubject`, etc., as defined in the other architecture documents.

## 4. Benefits of this Approach

1.  **Data Integrity**: Ensures that semantic processing always operates on a complete and chronologically accurate dataset, eliminating the problem of split conversations.
2.  **Decoupling**: Separates the concern of data fetching from data processing. The ingestion service can be scaled and managed independently of the processing logic.
3.  **Idempotency and Replayability**: Since the raw data is preserved, processing jobs can be re-run on the same dataset for debugging or after algorithm improvements. The `processed_state` flag helps manage this.
4.  **Scalability**: A centralized database is more scalable and manageable for large volumes of data than a file-based system.
5.  **Foundation for Advanced Features**: Provides the necessary foundation for complex, cross-batch analysis like temporal splitting and topic evolution tracking.
