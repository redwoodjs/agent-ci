# Speccing Feature Brainstorming 2026-02-09

## Initiated co-design for the "Speccing" subsystem
We are beginning the ideation and design phase for a new feature called "Speccing". This subsystem aims to leverage the Knowledge Graph (Moments and Subjects) to build comprehensive "blueprints" or "specs" for new work.

### The Vision
- **Goal**: Generate a detailed spec by replaying the history of a subject from the moment graph.
- **Input**: A user idea/context and a starting "subject" (found via vector search/API).
- **Process**:
    - Traverse the moment graph in chronological order.
    - For each moment, follow "provenance" links back to source documents (GitHub PRs, Issues, Discord threads, Cursor conversations).
    - Extract relevant details from these sources at the specific point in time the moment occurred.
    - Handle complex sources like Pull Requests by fetching and analyzing the diff.
    - Iteratively revise the spec based on additions, removals, learnings, and breaking changes found along the timeline.
- **Output**: A refined, leaf-node spec that captures the evolved state of the project's knowledge.

### Initial Findings and Discoveries
During the initial investigation, we identified several critical components and patterns:
- **Moment Traversal**: The functions `findDescendants` and `getSubjectContextChainForMoment` in `src/app/engine/databases/momentGraph/index.ts` are foundational. They allow us to walk the parent-child relationships that define a subject's history.
- **High-Fidelity Content**: We discovered that while "Moments" are summaries, the actual `MicroMoments` (chunks of source documents) are stored in `micro_moment_batches`. These batches contain the raw `content` we need to feed the agentic replay loop.
- **State Management Pattern**: We analyzed `momentReplay.ts` and the `moment_replay_runs` database schema. This pattern of a stateful "Run" with a "Cursor" and a "Priority Queue" is directly applicable to the speccing process.

## Deep-dive into Speccing Mechanics and "No Time Travel"
We are currently focusing on the nuanced requirements of the "Speccing" feature, specifically how to enforce the "No Time Travel" rule during a subject replay.

### Technical Consideration 1: Stateful Traversal (The Cursor)
To correctly traverse a moment graph that may have multiple branches or leaf nodes, we cannot rely on a simple recursive descent in a single agent turn.
- **Complexity**: Real-world histories are not linear. The agent might need to "pause" and "resume" as it processes different pieces of evidence.
- **Direction**: We need a stateful "cursor" on the API side. The API should calculate the "total order" of all moments related to a subject once, then serve them one-by-one. This prevents the agent from accidentally seeing "the future" of the subject before it's ready.

### Technical Consideration 2: High-Fidelity Details (Micro-Moments)
Moments alone are too summarized for "speccing" new work correctly.
- **Requirement**: For each step in the replay, the agent needs the *raw* content of the underlying `MicroMoments`. 
- **Time-Locking**: When serving details for a moment, the system must only expose `MicroMoments` or comments that have a `created_at` timestamp equal to or earlier than the moment itself. This is the "No Time Travel" clincher.

### Technical Consideration 3: On-the-fly PR Diffs
Pull Requests are critical evidence. Since our ingestion pipeline doesn't currently store the actual diff text, we will fetch them on-the-fly.
- **Mechanic**: The API provides the PR number (from `sourceMetadata`), and the agent executes `gh pr diff <number>` to get the raw changes. This keeps the engine lean and ensures we use the most accurate diff.

### Technical Consideration 4: Branching Graph Analysis (Code-based)
By analyzing `findDescendants` and `getSubjectContextChainForMoment` in `momentGraph/index.ts`, we've confirmed the system's branching architecture:
- **Graph Structure**: Each moment optionally references a `parentId`, forming a tree-like graph.
- **Traversal Mechanism**: The system already supports finding ancestors/descendants, but for replaying a subject "chronologically", we must interleave multiple branches.
- **Priority Queue Strategy**: We will use a Priority Queue (PQ) to walk the graph. Pop the moment with the earliest `createdAt`, push its children. This treats the entire history as a single, chronological "stream of events", which is the correct way to replay a subject's evolution regardless of parallel work branches.

### Technical Consideration 5: Time-Locked Content Extraction
Our analysis of `MicroMoment` (in `momentGraph/index.ts` L1754) and the `micro_moment_batches` table confirms:
- **Schema Support**: `MicroMoment` includes a `createdAt` field.
- **SQL-to-App Filtering**: We catch "historical context" by querying the batch for a document and filtering in application code (or via SQL `json_each`) to only include items where `createdAt <= M.createdAt`.
- **Result**: The agent receives a high-fidelity "snapshot" of the source document *as it existed* when the specific moment occurred, preventing any accidental leaks of future information.

## Consensus Point: Code Analysis vs. Live Examples
We have concluded that live production examples are not required for this design phase. The existing codebase (specifically `momentGraph/index.ts` and `momentReplay.ts`) provides exhaustive empirical evidence of the data structures and traversal requirements. We can move forward with high confidence in the technical feasibility of the Priority Queue and Time-Locked retrieval.

## Consensus Building: The "Revision" Loop
How should the agent handle information that gets superseded (e.g., a "Decision" at $T=2$ that reverts a "Decision" at $T=1$)?
- **Revised Approach**: Since we are "revising as we go", the agent will maintain a single "Working Spec".
- **Refinement Strategy**: When the agent encounters a moment that contradicts earlier state, it should:
  1.  Update the relevant section of the spec.
  2.  Add a brief "Note on Evolution" or "History" entry to that section explaining *why* the change happened (e.g., "Originally we planned X, but at [Moment Y] we switched to Z because...").
- **Benefit**: This preserves the narrative history of the project within the spec itself, rather than just presenting a static end-state.

### Final Investigation Checklist
- [x] Investigate `src/app/engine/databases/momentGraph/index.ts` for existing batch retrieval performance.
- [x] Determine if we need a new database table `spec_replay_state` to store the Priority Queue for active runs.
- [x] Align with user on "Working Spec" vs "Changelog" revision style.
- [x] Confirm `MicroMoment` schema supports chronological filtering.
