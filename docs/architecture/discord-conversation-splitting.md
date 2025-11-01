# Discord Conversation Splitting Architecture

## Problem

Discord exports contain thousands of messages spanning months. To preserve conversation context and enable meaningful analysis, we need to logically split these transcripts into coherent conversation units while maintaining thread relationships.

## Current State

- Discord messages are converted to markdown with threading preserved via `>` indentation
- All messages in a channel are processed as one large artifact
- Thread relationships are maintained but conversations span arbitrary time periods

## Conversation Splitting Strategy

### 1. Temporal Boundaries

**Time-based splitting** for natural conversation breaks:

- **Daily boundaries**: Split at midnight UTC to create daily conversation artifacts
- **Gap detection**: Split when >4 hours between consecutive messages
- **Weekend boundaries**: Split at Monday 00:00 UTC to separate work week conversations

### 2. Thread-based Grouping

**Preserve thread integrity** across temporal splits:

- **Thread continuity**: If a thread spans multiple days, include the full thread in each day's artifact
- **Thread metadata**: Track thread start/end times and participant counts
- **Cross-day threads**: Mark threads that span multiple temporal boundaries

### 3. Topic-based Clustering

**Semantic grouping** for related conversations:

- **Subject extraction**: Use LLM to identify conversation topics from message content
- **Topic boundaries**: Split when topic changes significantly (using embedding similarity)
- **Related threads**: Group threads discussing the same topic even if temporally separated

## Implementation Approach

### Phase 1: Temporal Splitting

```typescript
interface ConversationSplit {
  id: string;
  artifactId: string;
  startTime: string;
  endTime: string;
  messageCount: number;
  participantCount: number;
  threadCount: number;
  topics: string[];
  splitType: "temporal" | "topic" | "thread";
  parentSplitId?: string; // For nested splits
}

interface ConversationArtifact {
  id: string;
  sourceId: number;
  kind: "discord_conversation";
  providerId: string; // channel_id + split_id
  title: string; // Auto-generated from topics/participants
  content: string; // Markdown content
  contentFormat: "markdown";
  metadata: {
    channelId: string;
    guildId: string;
    splitType: string;
    threadIds: string[];
    participants: string[];
    topics: string[];
    messageCount: number;
    timeSpan: { start: string; end: string };
  };
}
```

### Phase 2: Smart Splitting Algorithm

```typescript
function splitConversations(messages: DiscordMessage[]): ConversationSplit[] {
  const splits: ConversationSplit[] = [];

  // 1. Temporal splitting
  const dailySplits = splitByDay(messages);

  // 2. Gap detection within days
  const gapSplits = splitByGaps(dailySplits, 4 * 60 * 60 * 1000); // 4 hours

  // 3. Thread integrity preservation
  const threadAwareSplits = preserveThreads(gapSplits);

  // 4. Topic-based refinement
  const topicSplits = refineByTopics(threadAwareSplits);

  return topicSplits;
}
```

### Phase 3: Subject Extraction

```typescript
interface ConversationSubject {
  id: string;
  name: string;
  description: string;
  kind:
    | "feature_request"
    | "bug_report"
    | "discussion"
    | "announcement"
    | "question";
  status: "active" | "resolved" | "archived";
  participants: string[];
  artifacts: string[]; // Related conversation artifacts
  createdAt: string;
  updatedAt: string;
}

function extractSubjects(
  conversation: ConversationArtifact
): ConversationSubject[] {
  // Use LLM to identify topics, participants, and conversation type
  // Extract key decisions, feature requests, bug reports
  // Link to related artifacts (PRs, issues, etc.)
}
```

## Data Model Updates

### New Tables

```sql
-- Conversation splits within artifacts
CREATE TABLE conversation_splits (
  id INTEGER PRIMARY KEY,
  artifact_id INTEGER NOT NULL,
  split_type TEXT NOT NULL, -- 'temporal', 'topic', 'thread'
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  participant_count INTEGER NOT NULL,
  thread_count INTEGER NOT NULL,
  topics TEXT, -- JSON array
  parent_split_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id),
  FOREIGN KEY (parent_split_id) REFERENCES conversation_splits(id)
);

-- Conversation-specific subjects
CREATE TABLE conversation_subjects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  participants TEXT, -- JSON array of user IDs
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Link subjects to conversation splits
CREATE TABLE conversation_subject_splits (
  subject_id INTEGER NOT NULL,
  split_id INTEGER NOT NULL,
  relevance_score REAL, -- 0-1 confidence in relevance
  PRIMARY KEY (subject_id, split_id),
  FOREIGN KEY (subject_id) REFERENCES conversation_subjects(id),
  FOREIGN KEY (split_id) REFERENCES conversation_splits(id)
);
```

### Updated Artifact Processing

```typescript
interface DiscordArtifactProcessor {
  // Split large Discord exports into conversation units
  splitConversations(artifact: Artifact): Promise<ConversationSplit[]>;

  // Extract subjects from conversation content
  extractSubjects(split: ConversationSplit): Promise<ConversationSubject[]>;

  // Generate conversation summaries
  summarizeConversation(split: ConversationSplit): Promise<string>;

  // Link to related artifacts (PRs, issues, etc.)
  linkRelatedArtifacts(subject: ConversationSubject): Promise<Artifact[]>;
}
```

## UI/UX Implications

### Stream Views

- **Conversation streams**: Group by subject rather than raw message time
- **Thread navigation**: Show thread relationships within conversations
- **Participant tracking**: Highlight key contributors to topics
- **Topic evolution**: Show how discussions develop over time

### Search and Discovery

- **Topic-based search**: Find conversations by subject matter
- **Participant filtering**: Filter by who was involved
- **Temporal navigation**: Jump between related conversations
- **Cross-reference**: Link to related PRs, issues, commits

## Implementation Plan

### Phase 1: Basic Temporal Splitting ✅ IMPLEMENTED

1. ✅ Implement temporal gap-based conversation splitting (4-hour threshold)
2. ✅ Preserve thread relationships using reply_to_message_id
3. ✅ Generate conversation metadata (participants, threads, message counts)
4. ✅ Store conversation splits to R2 with markdown format
5. ✅ Create conversation_splits database records

**Implementation:** `src/app/ingestors/discord/split-conversations.ts`

API Endpoint: `POST /ingestors/discord/split-conversations`

- Optional query param: `?artifactID=123` to process a specific artifact
- Without params: processes all unprocessed artifacts

### Phase 2: LLM-based Subject Extraction ✅ IMPLEMENTED

1. ✅ Implement LLM-based subject extraction using OpenAI GPT-4o
2. ✅ Create Discord-specific prompt for conversation analysis
3. ✅ Extract subjects with facets, aliases, and line mappings
4. ✅ Store subjects in database linked to artifacts
5. ✅ Store subject JSON to R2 for reference

**Implementation:** `src/app/ingestors/discord/extract-subjects.ts`

API Endpoint: `POST /ingestors/discord/extract-subjects`

- Optional query param: `?conversationSplitID=123` to process a specific split
- Optional query param: `?artifactID=123` to process all splits for an artifact
- Without params: processes all unprocessed splits

### Phase 3: Advanced Features (Future)

1. Cross-artifact linking (Discord → GitHub PRs/Issues)
2. Multi-subject detection per conversation
3. Conversation summarization
4. Participant analysis and tracking
5. Automated subject categorization by type
6. Semantic similarity-based conversation grouping

## Benefits

- **Preserved context**: Conversations maintain their logical boundaries
- **Better search**: Find discussions by topic rather than time
- **Reduced noise**: Filter out unrelated messages within time periods
- **Enhanced analysis**: Track topic evolution and participant engagement
- **Cross-platform linking**: Connect Discord discussions to GitHub activity

## Risks and Mitigations

- **Thread fragmentation**: Risk of breaking thread relationships
  - _Mitigation_: Always include full thread context in splits
- **Topic drift**: Conversations may span multiple topics
  - _Mitigation_: Allow multiple subjects per conversation
- **Performance**: Large conversation processing
  - _Mitigation_: Stream processing and incremental updates
- **Subject accuracy**: LLM may misclassify topics
  - _Mitigation_: Human review interface and confidence scoring
