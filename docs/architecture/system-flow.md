# System Flow

We designed our system to transform raw, chaotic event streams into a structured, queryable knowledge graph. While our initial approach prioritized "live" indexing for speed, we found that complex narrative synthesis requires a rigorous, replayable environment to test improvements. 

Today, the system operates in two modes that share the same brain: a **Simulation Pipeline** (for backfills, replays, and development) and a **Live Pipeline** (for low-latency updates).

## The Simulation Pipeline

We built the Simulation Pipeline to solve a specific problem: "How do we safely improve our logic when the data is constantly changing?" 

The simulation engine treats data processing not as a stream, but as a series of resumable, inspectable **Phases**. By persisting the state after each distinct operation, we can pause, debug, and even restart execution from the middle of the pipeline. This allows us to iterate on our "smart" logic (like linking or synthesis) without re-running expensive ingestion steps.

The data flows through eight distinct phases, moving from raw external state to a fully linked graph.

### 1. Ingestion & Diffing
The process begins by looking at the outside world. In the `ingest_diff` phase, various **Plugins** (GitHub, Discord, etc.) fetch the current state of source documents and compare them against our last known state. We do this first so that we can immediately discard anything that hasn't changed, saving downstream compute.

### 2. Micro-Batching
Once we have a set of changed documents, we need to prepare them for the LLM. The `micro_batches` phase splits large documents into manageable chunks and generates **Embeddings** for them. These distinct, vector-ready units are called "Micro-Moments". We isolate this as a separate step because chunking logic rarely changes, but the downstream synthesis prompts change often.

### 3. Macro Synthesis
This is where the raw text is transformed into meaning. In `macro_synthesis`, we feed the stream of Micro-Moments into an LLM to generate "Macro-Moments"—high-level summaries of what happened. This phase focuses purely on understanding the *content* and *narrative* of a single document, without worrying about how it connects to the rest of the world.

### 4. Classification
Not every moment is equal. The `macro_classification` phase acts as a filter, allowing us to label moments (e.g., distinguishing a "Bug Fix" from a "Chore") and gate which ones are important enough to enter the permanent graph.

### 5. Materialization
Up to this point, our data has been transient. The `materialize_moments` phase acts as the **Commit Point**. It writes the synthesized moments into the database with **Stable IDs**. Once materialized, a moment "exists" in our system and can be linked to.

### 6. Deterministic Linking
Now we begin to stitch the graph together. We start with what we know for sure. The `deterministic_linking` phase looks for explicit signals—like a "Fixes #123" string in a PR body—to create high-confidence links between moments. We run this before fuzzy vector search because it is fast, cheap, and precise.

### 7. Candidate Generation
For connections that aren't explicitly stated, we need to search. The `candidate_sets` phase uses vector embeddings to find moments that *might* be related. We separate this "search" step from the final "decision" step so that we can inspect the recall of our retrieval (i.e., "Did we find the right candidate?") independently of the LLM's judgment.

### 8. Timeline Fit
 Finally, we make the call. The `timeline_fit` phase evaluates the candidates and decides which parent is the best fit for the current moment, enforcing logical constraints (like time causality). This completes the graph, turning a loose collection of events into a connected narrative.

## Pipeline Resiliency

In a distributed system, jobs can fail silently (e.g., Worker OOM, Time Limit Exceeded), leaving the simulation in an indeterminate state. To ensure robustness, we implemented a **Supervisor Pattern**:

1.  **Watchdog Heartbeat**: A CRON job (`processResiliencyHeartbeat`) runs every minute to "poke" all active simulation runs. This ensures the runner wakes up periodically, even if the queue is empty.
2.  **Supervisor Check**: Before processing new work, the Phase Runner invokes a mandatory `recoverZombies` routine.
3.  **Zombie Sweeper**: Each phase defines logic to identify and fail "Zombie Tasks"—items that have been `enqueued` for too long (e.g., >15 minutes) without an update.

 This ensures the simulation always converges to a terminal state (Completed or Failed) and never stalls indefinitely due to transient infrastructure failures.

## Unified "Orchestrator" Architecture

Running two parallel pipelines (Live vs. Simulation) introduces a risk: the logic might drift. If the Live pipeline calculates a checksum one way, and the Simulation pipeline does it another, our replays become useless as predictors of live behavior.

To solve this, we use a **Unified Orchestrator** pattern. 

There is only one code path for execution: `executePhase`. We inject **Strategies** to handle the environmental differences:
*   **Live Strategy**: Uses `NoOpStorage` (speed) and `DirectTransition` (latency).
*   **Simulation Strategy**: Uses `ArtifactStorage` (inspectability) and `QueueTransition` (throughput/backpressure).

This ensures that while the *runtime mechanics* differ to suit the use case, the *decisions* and *logic* are identical because they are the exact same code running in the exact same `PipelineContext`.
