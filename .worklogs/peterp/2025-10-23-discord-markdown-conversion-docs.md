# Discord Ingestion Pipeline Documentation

## Date: October 23, 2025

## Summary

Documented the Discord ingestion pipeline's two-stage architecture for fetching messages from Discord and storing them as artifacts. Created comprehensive architecture documentation and component README explaining the ingestion and storage processes.

## Problem Statement

The codebase had a significant architectural change to the Discord ingestion system: a two-stage pipeline that separates fetching (ingest) from storage (store). This architecture needed documentation to explain:

1. Why the two-stage design (ingest + store)
2. How messages flow through the system
3. The complete data path from Discord API to artifacts
4. The rationale behind design decisions

Without this documentation, future developers would struggle to understand the purpose and behavior of the ingestion pipeline.

## Solution Approach

### Step 1: Analyzed Existing Code

Reviewed the Discord ingestor implementation across multiple files:

- `src/app/ingestors/discord/ingest.ts`: Stage 1 - fetches from Discord API
- `src/app/ingestors/discord/process.ts`: Stage 2 - stores to R2 bucket and creates artifacts
- `src/app/ingestors/discord/migrations.ts`: Database schema for raw messages
- `src/db/migrations.ts`: Main database migrations for artifacts
- `src/app/ingestors/discord/routes.ts`: HTTP endpoints

Found that the pipeline:

1. Fetches Discord messages via API and stores in raw SQLite table
2. Processes unprocessed messages by grouping them by channel
3. Writes normalized JSON and metadata to R2 bucket
4. Creates artifact records linking to the bucket storage

### Step 2: Identified Key Design Decisions

The two-stage pipeline design separates concerns:

- **Stage 1 (Ingest)**: API interaction and raw storage
- **Stage 2 (Store)**: Moving data to persistent storage and creating artifact records
- Benefits: Decoupling, resilience, audit trail, flexible scheduling

Rate limiting is sophisticated:

- Respects Discord's X-RateLimit headers
- Exponential backoff with 3 retry attempts
- Parses Retry-After headers

Incremental ingestion uses cursor-based pagination to fetch only new messages.

### Step 3: Created Architecture Documentation

Generated `docs/architecture/discord-ingestion-pipeline.md` containing:

- Visual ASCII architecture diagram
- Detailed explanation of both pipeline stages
- Discord API interaction specifics (rate limiting, pagination)
- Message storage format specification
- Database schema for raw_discord_messages table
- API endpoint documentation
- Error handling strategy
- Design rationale for key decisions
- Future enhancement possibilities (including markdown conversion)

### Step 4: Created Component README

Generated `src/app/ingestors/discord/README.md` containing:

- Quick start guide for developers
- File structure explanation
- Configuration instructions
- Output format documentation with examples
- Implementation details for each stage
- Database schema reference
- Debugging tips
- Future work items

## Key Findings

1. **Two-Stage Pipeline**: The separation of ingest and store stages is intentional and provides benefits for resilience and flexibility.

2. **Current Output**: Messages are stored as normalized JSON with metadata. Markdown conversion is planned as a future enhancement.

3. **Rate Limiting**: The system includes sophisticated rate limit handling with exponential backoff and respect for Discord's rate limit headers.

4. **Incremental Ingestion**: The system fetches only new messages using cursor-based pagination, reducing API overhead for large channels.

5. **Audit Trail**: Raw Discord API responses are preserved in the raw_discord_messages table, maintaining complete history.

6. **Source Auto-Creation**: The store stage automatically creates Discord source records if they don't exist, maintaining referential integrity.

## Correction Made

Initial documentation incorrectly described markdown conversion as currently implemented. This is actually planned as future work. Documentation was updated to:

- Clarify that Stage 2 stores raw message data (JSON + metadata)
- Move markdown format discussion to "Future Considerations"
- Adjust output file structure to remove non-existent messages.md
- Update future work priority list to place markdown first

## Documentation Created

1. **Architecture Documentation**: `docs/architecture/discord-ingestion-pipeline.md`

   - 280+ lines covering complete pipeline
   - Visual diagrams of data flow
   - Detailed stage-by-stage explanation
   - Design rationale and future work

2. **Component README**: `src/app/ingestors/discord/README.md`

   - 300+ lines of developer documentation
   - Quick start guide
   - Implementation details
   - Configuration and debugging

3. **Work Log**: `.worklogs/peterp/2025-10-23-discord-markdown-conversion-docs.md`
   - Documents the documentation effort

## Impact

Future developers can now:

- Understand the two-stage architecture and why it's designed that way
- Trace message flow from Discord API through to artifact storage
- See what output formats are generated and where they're stored
- Understand the rate limiting and pagination logic
- Debug issues by following the documented data path
- Make informed decisions about implementing markdown conversion
- Extend the pipeline for other sources using the same pattern

## Notes for Future Work

1. Markdown conversion is the next priority for the Discord ingestor
2. Hardcoded channel list should be made configurable via sources table
3. Architecture supports multiple ingestor types using same Sources → Artifacts pattern
4. Additional features planned: threads, reactions, attachments, webhooks
