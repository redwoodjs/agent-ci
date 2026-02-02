# System Flow

We designed our system to transform raw, chaotic event streams into a structured, queryable knowledge graph. While our initial approach prioritized "live" indexing for speed, we found that complex narrative synthesis requires a rigorous, replayable environment to test improvements. 

Today, the system operates in two modes that share the same brain: a **Simulation Pipeline** (for backfills, replays, and development) and a **Live Pipeline** (for low-latency updates).

## The Simulation Pipeline

We built the Simulation Pipeline to solve a specific problem: "How do we safely improve our logic when the data is constantly changing?" 

The simulation engine treats data processing not as a stream, but as a series of resumable, inspectable **Phases**. By persisting the state after each distinct operation, we can pause, debug, and even restart execution from the middle of the pipeline.

The data flows through eight distinct phases, moving from raw external state to a fully linked graph.

### 1. Ingestion & Diffing
The process begins by looking at the outside world.
*   **Input**: `r2_key` pointing to a raw JSON file in our bucket.
*   **Action**: A **Plugin** (e.g., GitHub, Discord) parses the JSON and normalizes it into a standard `Document` object.
*   **Database Read**: We check `db.document_checksums` to see if we have processed this exact content before.
*   **Database Write**: If new, we update the checksum table.
*   **Output**: A normalized `Document` object (in-memory).

### 2. Micro-Batching (Chunk & Embed)
Once we have a Document, we need to prepare it for search.
*   **Input**: `Document`.
*   **Action**: 
    1.  The Plugin splits the document into logical `Chunks` (e.g., separating a PR body from its comments).
    2.  We generate **Vector Embeddings** for each chunk. These are "Micro-Moments".
*   **Database Write**: We store the embeddings in our Vector Index (for future candidate generation).
*   **Output**: A list of `MicroMoment` items (Chunks + Vectors).

### 3. Macro Synthesis
This is where raw text becomes meaning.
*   **Input**: Stream of `MicroMoment` items.
*   **Action**: An LLM reads the stream and synthesizes a high-level narrative (e.g., "User X reported a bug", "PR Y fixed it"). This works purely on the *content* of the document.
*   **Output**: `MacroStream` (Draft moments).

### 4. Classification
Not every synthesized moment matters.
*   **Input**: `MacroStream`.
*   **Action**: An LLM acts as a filter, tagging items as "Feature", "Bug", or "Noise".
*   **Output**: `ClassifiedStream` (Filtered items).

### 5. Materialize (The Commit Point)
Up to this point, data has been transient (passing through the pipeline). Now we make it real.
*   **Input**: `ClassifiedStream`.
*   **Database Write**: We **INSERT** the classified items into the primary `moments` table. They are assigned stable **UUIDs**.
*   **Significance**: Once materialized, a moment "exists" in the graph and can be linked to by subsequent documents.

### 6. Deterministic Linking
We stitch the graph together, starting with explicit signals.
*   **Input**: `moment_id`.
*   **Database Read**: We fetch the moment body and scan for identifiers (e.g., "Fixes #123"). We then query `db.find('gh:123')` to find the target.
*   **Database Write**: If found, we **INSERT** a row into the `links` table.
*   **Output**: Link metadata.

### 7. Candidate Generation
For implicit connections, we use search.
*   **Input**: `moment_id`.
*   **Database Read (Vector)**: We query the Vector Index with the moment's embedding.
*   **Database Read (Graph)**: We fetch metadata for the top K matching IDs.
*   **Action**: We filter out candidates that are historically impossible (e.g., created *after* the current moment).
*   **Output**: A list of `Candidate` objects.

### 8. Timeline Fit
Finally, the LLM acts as the Judge.
*   **Input**: `moment_id` + `Candidate[]`.
*   **Action**: The LLM reviews the pair and decides if they are causally related. It performs a "Veto Check" to ensure the timeline makes sense.
*   **Database Write**: If the LLM approves, we **INSERT** a row into the `links` table.

## Pipeline Resiliency

In a distributed system, jobs can fail silently. To ensure robustness, we implemented a **Supervisor Pattern**:
1.  **Watchdog Heartbeat**: A CRON job "pokes" active runs every minute.
2.  **Zombie Sweeper**: We automatically fail tasks that have been "running" for too long without an update.

## Unified "Orchestrator" Architecture

Running two parallel pipelines (Live vs. Simulation) risks logic drift. We solve this with the **Unified Orchestrator**.

There is only one code path: `executePhase`. We inject **Strategies** to handle the environment:
*   **Live Strategy**: Uses `NoOpStorage` (speed) and `DirectTransition` (latency).
*   **Simulation Strategy**: Uses `ArtifactStorage` (inspectability) and `QueueTransition` (throughput).

This ensures that while the *mechanics* differ, the *logic* (decisions, linking, classification) is identical.
