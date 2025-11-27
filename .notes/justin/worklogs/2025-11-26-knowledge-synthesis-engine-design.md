# Work Log: Knowledge Synthesis Engine Design

**Date:** 2025-11-26

## 1. Problem & Motivating Use Cases

The current RAG engine is effective for retrieving factual information ("what" or "where"), but it cannot answer "why" questions that require understanding intent, causality, and narrative. The goal is to design a system that synthesizes events from multiple sources (Discord, GitHub, Cursor chats) into coherent "memories."

This was motivated by several key use cases:

*   **Code Archeology:** A developer highlights a block of code and asks, "How and why did this get here?" The system should be able to trace the code back to its originating discussion, issue, and PR, and explain the original intent.
*   **Automated PR Guidance:** Analyzing a PR's code changes and related context to automatically generate manual testing steps for a preview environment.
*   **Project Management Assistance:** Querying the system for high-level status updates, such as "What is Peter currently working on?" or "Is anyone blocked on a task?"

## 2. Core Idea: What is a "Subject"?

The core shift is moving beyond a simple RAG system (which retrieves raw information) to a system that understands **narrative, intent, and causality** within a project. The goal is to answer "why?" questions, not just "what?" or "where?".

The central concept is the **"Subject"** (also referred to as "Topics"): long-lived, evolving entities that represent a single, coherent stream of work, discussion, or thought.

A "Subject" isn't just a document; it's a collection of artifacts and the synthesized story that connects them. For example:

*   **Subject:** "Fix Mantine Tree-Shaking Issue"
*   **Timeline/Artifacts:**
    1.  A user's message on Discord (the "point of inception").
    2.  The ensuing discussion.
    3.  A GitHub Issue created to track the work.
    4.  A Pull Request with the code changes.
    5.  The `git` commit that merged the fix.
*   **Synthesized Memory:** A concise narrative explaining that a user reported an issue with Mantine components not being tree-shaken, which led to an investigation and a custom Vite plugin to resolve it.

This "memory" is the key. It's generated while the context is "warm" and then stored, so the system doesn't have to re-derive the intent from a cold sea of data every time a question is asked.

## 3. Initial Implementation Sketch

A high-level implementation approach was proposed, breaking down the problem into several key components:

### 3.1 Subject Identification & Correlation

The first step is to group incoming information into Subjects. This is fundamentally a clustering problem.

*   **Inception:** A new "Subject" is born when a new, distinct topic appears. This could be a new GitHub issue, a new top-level post in a support channel, or a message that has low semantic similarity to any existing, active Subjects.
*   **Correlation:** As new documents are ingested (PR comments, chat messages, commits), we need to associate them with existing Subjects.
    *   **Explicit Links:** These are easy. PRs linking to issues (`closes #123`), commit messages with `Fixes #...`, replies within a thread.
    *   **Implicit Links:** This is where it gets interesting. We can use vector embeddings. When a new document comes in, we compare its embedding to the embeddings of active Subjects. If it's sufficiently similar, we append it to that Subject's timeline.

### 3.2 Memory Synthesis

Once a Subject has a collection of associated documents, we can create the "memory."

This would likely be an LLM-powered process. Periodically, or when a Subject's state changes (e.g., an issue is closed), we can feed all the associated documents (the issue description, PR conversation, chat logs) into an LLM with a prompt like: *"Summarize the following events into a coherent narrative. Explain the problem, the proposed solution, and the outcome."*

The output would be a structured object containing the narrative summary, title, status (open/closed), and links to all source artifacts.

### 3.3 Linking Code to Subjects

This is the crucial step for answering the "Why is this code here?" question.

The bridge between the world of discussion (GitHub, Discord) and the world of code is `git`. The primary link is the **commit SHA**.

#### At Indexing Time

When a PR associated with a Subject is merged, the system will:
1.  Extract the commit SHA(s) from the PR.
2.  Store a direct association between each commit SHA and the Subject ID.
3.  As part of the asynchronous code analysis, generate a natural-language summary of the diff. This summary, *not the raw code or file paths*, is stored as part of the Subject's narrative. This provides a scalable way to encapsulate the change.

#### At Query Time

The workflow for answering a user's query about code depends on the environment from which the query originates.

##### Scenario 1: Query from a Context-Rich Environment (e.g., IDE)
1.  **User Action:** The user selects a block of code in their editor and asks a question.
2.  **System Action (Client-side):** The editor plugin runs `git blame` locally on the user's file to retrieve the relevant commit SHA(s).
3.  **System Lookup:** The plugin sends the commit SHA(s) to the backend, which looks them up in the Subjects store to find the associated Subject(s).
4.  **System Response:** The system returns the synthesized "memory" for the found Subject(s).

##### Scenario 2: Query from a Context-Poor Environment (e.g., Chat Bot)
In this case, the user must provide the context, typically as a URL.
*   **For questions about a PR (`<pr_url>`)**: The system uses the URL to look up the associated Subject directly. It relies on the pre-generated summary of the PR's diff that was created at indexing time.
*   **For questions about a specific code snippet**: The user must provide a link to the code on a platform like GitHub.
    1.  **User Action:** The user provides a URL to a file and line range.
    2.  **System Action (Backend):** The backend receives the URL and uses a centralized **Git Service** to run `git blame` on the specified file and lines. This service maintains its own checkouts of the repositories.
    3.  **System Lookup:** Once the Git Service returns the commit SHA(s), the backend looks them up in the Subjects store.
    4.  **System Response:** The system returns the synthesized "memory" for the found Subject(s).

If a user pastes a raw code snippet into the chat without a link, the system should respond by asking for a URL to provide the necessary context.

### 3.4 Architecture Overview

This doesn't necessarily require a complete rewrite of the existing engine. It could be a new layer on top.

*   **Ingestion Pipeline:** Remains largely the same.
*   **Subject Engine (New Service):** A new service (perhaps a Durable Object) that maintains the state of all Subjects. It would receive ingested documents, perform the correlation logic, and trigger the synthesis process.
*   **Knowledge Store:** You'd need a place to store these Subject objects. This could live alongside your existing vector stores. It's essentially building a lightweight knowledge graph where Subjects are the primary nodes.

## 4. Challenges & Architectural Concerns

After reviewing the initial sketch, several critical challenges were identified:

### 4.1 Embeddings May Not Be Enough for Correlation

The concern: embeddings may not be sufficient to determine whether a new artifact belongs to an existing Subject or represents a new one.

**Example:** In the Mantine case, if the solution discussed in Cursor chat was barrel files, early chat messages might have good semantic overlap because the problem is fresh in context. But later messages, not necessarily. During deep debugging sessions (sometimes iterating through 30-60 attempts), if someone says "the barrel files worked! i had to write them to file at start of esbuild optimize deps run", what would there be to go on? The semantic content has drifted far from the original problem statement.

This suggests we need a more sophisticated correlation mechanism than simple vector similarity.

### 4.2 How to Amend Current Architecture

The concern: we're vectorizing all this existing stuff - will we still even need it? If so, how does it relate to the new Subjects system?

If we store everything in the same index, our memories (the coalesced valuable stuff) will be drowned by the noise of the rest. So perhaps a different index? But that begs the question: do we need existing indexing even? And the existing index probably won't scale anyway.

This points to the need for a clear separation between the two stores and a well-defined query strategy.

### 4.3 What Details to Store, and How to Retrieve Them?

The concern: what details are we storing about entities for the memories, and how are we retrieving them? Are we leveraging existing plugin design and its goals? Does all this fall away, or does it still serve a purpose?

The plugins don't have to stay around for the sake of it, but we need to make sense of how things fit together.

### 4.4 Code Analysis for PRs

The concern: how are we going to do code analysis so we can describe the changes in a PR? This feels necessary for the use cases we discussed.

There are some technical challenges here. Maybe we have a code analysis LLM looking at PR diff solely - like a higher reasoning model specializing in code (expensive, probably slow), but if we're careful in our usage of it that can be manageable.

This suggests code analysis should be an indexing-time task, not query-time, to manage cost and latency.

### 4.5 Other Open Questions

Several other challenges remain:

*   **Subject Granularity:** How big or small is a Subject? Does a big feature contain smaller bug-fix Subjects? This suggests a need for nested or linked Subjects.
*   **Historical Data:** How do you build this knowledge for a project's entire history? It would require a backfilling process to trawl through old commits and issues to reconstruct historical Subjects.
*   **UI/Introspection:** How do you expose this? The idea of making Machinen's "understanding" introspectable is powerful. A simple UI that lists active Subjects and their timelines could be a great starting point and a compelling demo.

## 5. Evolution of the "Subject" Model

The core of the design is the "Subject," an entity that groups and contextualizes related events. The model for this entity evolved through several stages of refinement in response to the challenges identified.

### Stage 1: "Subjects" as Flat Timelines

The initial concept was a "Subject" as a flat collection of artifacts. Correlation would rely on a combination of vector similarity and explicit links (e.g., PRs linking issues). An LLM would then summarize the entire collection into a single narrative.

*   **Challenge:** Simple vector similarity is too brittle. The semantic content of a conversation can drift significantly during problem-solving, breaking the correlation between the initial problem and the eventual solution.

### Stage 2: The "Semantic Chain"

To address semantic drift, the model was refined to a "Semantic Chain," a linked list of events. This focuses on the causal link between successive steps rather than the global similarity of all steps. An LLM's task shifts from a one-shot summary to incrementally explaining the connection between the *last event* and a *new event*.

*   **Challenge:** A single, linear chain for a complex subject could become bloated with low-level, noisy details (e.g., dozens of failed attempts during a debugging session), obscuring the high-level narrative.

### Stage 3 (Current Approach): Hierarchical "Fractal" Subjects

The current model introduces a hierarchical, tree-like structure. This manages complexity by separating high-level narrative from low-level detail.

*   **Parent & Child Subjects:** A high-level goal (e.g., "Fix Mantine Tree-Shaking") is a **Parent Subject**. A focused, granular activity (e.g., a specific Cursor chat session) becomes a **Child Subject**.
*   **Low-Level Chain Building:** The detailed, `A -> Z` semantic chain is built within the Child Subject.
*   **Synthesis & Promotion:** When a Child Subject concludes, an LLM synthesizes its entire detailed chain into a single, concise summary of the key outcome. This summary is then **"promoted"** to become a single node on the Parent Subject's timeline.

This hierarchical model preserves granular detail for deep dives while ensuring the main narrative remains clean, concise, and focused on only the most significant milestones.

## 6. Core Architectural Principles

After working through the challenges and refinements, several foundational architectural decisions were established:

*   **Two-Tiered Knowledge Store:** The system will maintain two distinct stores:
    *   **RAG Index (The "Evidence Locker"):** The existing store for raw, complete, low-level data. It serves as the source of ground truth for specific, factual queries.
    *   **Subjects Store (The "Synthesized Memory"):** A new, smaller, more structured store containing the high-level narratives, timelines, and discovered intents. This is optimized for answering "why" questions.
    *   **Query Strategy:** Queries will first search the Subjects Store for high-level narrative and fall back to the RAG Index for specific, detailed evidence. This prevents high-value memories from being drowned by noise.

*   **Indexing-Time Code Analysis:** To support use cases like generating testing steps for a PR, code analysis will be performed as an asynchronous, indexing-time task. When a PR is merged, a background job will send the diff to a specialized, high-reasoning LLM to generate a natural-language summary of the changes. This summary is then stored as part of the relevant Subject. This approach manages cost and latency by avoiding query-time analysis.

*   **Plugin-Driven Architecture:** The existing plugin design remains critical. Plugins act as source-aware adapters that parse data from specific sources (GitHub, Discord) and provide structured artifacts to a central, source-agnostic "Subject Engine" for reasoning and correlation. The plugins provide the structured data; the engine provides the cross-source reasoning.

*   **Multi-Layered Correlation:** To address the limitations of simple vector similarity, correlation will use multiple layers:
    1.  **Explicit Links:** High-confidence heuristics like PRs linking to issues, commit messages referencing issues, replies within threads.
    2.  **State & Context Awareness:** The system should maintain state for active subjects, giving higher relevance to activity from users known to be working on that subject.
    3.  **LLM as Correlation Judge:** As a fallback for artifacts without explicit links, an LLM can be prompted to determine if a new piece of information belongs to an existing active subject or represents a new one. This is more expensive but provides reasoning capabilities beyond simple similarity.

## 7. Querying, The Knowledge Graph, and Pragmatic Implementation

Further discussion clarified the nature of querying and the underlying data model, leading to a more sophisticated architectural view.

### The Two-Stage Query Pipeline

For the system to handle ambiguous, natural-language queries (especially from context-poor environments like chat), a two-stage query pipeline is necessary:

1.  **Stage 1: Subject Identification.** The primary task is to use the user's query and any available conversational context to identify the most relevant **Subject(s)**. This provides the crucial "narrowing down" of the search space.
2.  **Stage 2: Information Extraction.** Once a Subject context is established, a more focused search is performed *within that Subject's data* (its narrative, artifacts, and child subjects) to find the specific answer.

Initial queries are assumed to be about a single subject. Handling queries that span multiple subjects is a more advanced case to be considered later.

### The Fractal Model as a Knowledge Graph

The "fractal" or hierarchical model of Subjects is best understood as a **Knowledge Graph**, not a simple vector store.

*   **Storage:** Subjects (both parent and child) are **nodes** in a graph. Relationships like "child of" or "promoted from" are **edges**. The textual narratives and summaries associated with each node are what get vectorized.
*   **Retrieval ("Reverse Vector Search"):** The retrieval process involves more than a simple vector lookup.
    1.  A user's query is vectorized to find the most relevant **entry-point nodes** in the graph (often the detailed "leaf" subjects).
    2.  The system then **traverses the graph** from these entry points upwards along the edges to their parents, gathering the full, multi-level context.

This graph structure is what allows the system to understand the relationships between high-level goals and low-level details, and it provides a natural way to handle complex queries that might span different parts of the knowledge base.

### A Pragmatic Approach to Implementation

A pragmatic approach is required to manage the complexity of this design: **Design with the future in mind, but implement for the present.**

*   **Design for Provision:** The data structures and system boundaries will be designed to support advanced use cases (e.g., IDE-based code queries) from the start. Storing `commit SHA -> Subject ID` links is a key example of this.
*   **Implement the Simplest Thing First:** The initial implementation will focus on delivering core value first. This likely means supporting PR-level questions via links in a chat environment, deferring the more complex client-side IDE integrations and backend Git services until the core Subject creation and synthesis engine is proven.

### Client-Agnostic State Management via `clientId`

To handle stateful conversations in a scalable and client-agnostic way, a `clientId`-based approach will be used. This decouples the core engine's state management from the specific implementation of any given client (Discord bot, Cursor extension, etc.).

The responsibility is clearly defined: the client is responsible for maintaining its own identity for a conversation and presenting that identity to the stateful backend.

1.  **Client-Generated ID:** Each client (Discord bot, Cursor extension) is responsible for generating and managing a unique identifier for each distinct conversational session (e.g., a Discord thread ID or a Cursor chat panel ID).
2.  **Stateful Backend Service:** The backend will maintain a state store (e.g., Durable Objects, KV) that maps these `clientId`s to a `ConversationState` object.
3.  **The State Object:** The state object will contain, at a minimum, the `activeSubjectId` for the conversation and a history of recent messages to provide context for follow-up queries.
4.  **Interaction Flow:** The client sends its `clientId` with every request. The backend uses this ID to retrieve, use, and update the conversational state for each interaction, ensuring continuity.

This model allows the backend to remain agnostic to the nature of the client, while empowering each client to define what constitutes a "session" according to its own logic.

## 8. Clarifying the Role of the "Evidence Locker"

A challenge was raised to the necessity of the "Evidence Locker" (the existing RAG index). If the Subjects in the Knowledge Graph contain backlinks to the original source documents in R2, an argument could be made to fetch these full documents at query time rather than maintaining a separate, pre-indexed vector store.

This "backlinks only" approach was analyzed and determined to have critical flaws in precision and performance:

*   **Precision:** Searching raw, full documents at query time would rely on clumsy keyword matching or slow, expensive, and unreliable retrieval by a large-context LLM.
*   **Performance:** Fetching multiple full documents from R2 at query time would introduce significant latency before searching could even begin.

The conclusion is that the **"Evidence Locker" is not redundant**. It serves a distinct and vital purpose as a pre-computed, semantic search index over the raw evidence. The two systems work in concert:

*   The **Knowledge Graph** answers the "why" and tells you *which documents to look at*.
*   The **"Evidence Locker"** answers the "what" and tells you the *exact, semantically relevant paragraph within those documents*.

A concrete example involving a developer asking first "Why is this code here?" (answered by the Knowledge Graph) and then "What were the exact details of the issue?" (answered by the Evidence Locker) solidified this distinction.

## 9. The Necessity of Stateful Conversations

The concrete example also revealed a critical, implicit requirement: for the two-tiered system to be effective in an interactive setting (like a chat bot), conversations must be **stateful**.

A stateless system would be unable to handle follow-up questions, as it would lose the context of the initial query. The **Subject** was identified as the natural unit of conversational state. When a user's query identifies a Subject, that Subject becomes the **"active context"** for the conversation. This state is then used to:

1.  **Disambiguate** follow-up questions for the LLM.
2.  **Constrain search** in the Evidence Locker by applying a powerful metadata filter (e.g., `WHERE subjectId = '...'`), dramatically improving speed and accuracy.

## 10. Refining State Management to be Client-Agnostic

The initial discussion on state management considered client-specific implementations (e.g., tying state to Discord threads or IDE UI state). This was refined to a more robust, decoupled architectural pattern based on a `clientId`.

The responsibility is now clearly defined: **the client is responsible for maintaining its own identity for a conversation and presenting that identity to the stateful backend.**

The backend will be a client-agnostic service that maps a given `clientId` to a `ConversationState` object containing the `activeSubjectId` and recent message history. This allows each client (Discord, Cursor, etc.) to define what constitutes a "session" by its own logic, without requiring any changes to the backend.

## 11. Clarifying the Plugin API with Namespaces

A concern was raised that as the system evolves to feed two distinct pipelines (Subjects and Evidence), the single list of hooks in the plugin API could become convoluted and unclear. A developer might not know which pipeline a given hook pertains to.

To solve this, the plugin API will be restructured to use **namespaces**. This makes the separation of concerns explicit.

```typescript
const MyPlugin: Plugin = {
  name: "MyPlugin",

  // Shared, pipeline-agnostic entry point
  prepareSourceDocument: async (r2Key, body) => { /* ... */ },

  // Hooks ONLY for the Evidence Locker (RAG)
  evidence: {
    splitDocumentIntoChunks: async (document) => { /* ... */ },
    reconstructContext: async (chunks) => { /* ... */ },
    // ... other RAG-specific hooks
  },

  // Hooks ONLY for the Subjects Knowledge Graph
  subjects: {
    provideCorrelationHints: async (artifact) => { /* ... */ },
    // ... other Subject-specific hooks
  }
};
```

This structure ensures clarity and clean extensibility, allowing the two pipelines to evolve independently while keeping all the logic for a single data source consolidated in one plugin.
