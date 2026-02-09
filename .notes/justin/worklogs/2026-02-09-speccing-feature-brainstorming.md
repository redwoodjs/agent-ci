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
- **High-Fidelity Content (Corrected)**: We misunderstood the role of MicroMoments. They are the *first level of summarization*, not raw text. MacroMoments are further distillations of consequential turning points. To build a high-fidelity spec, we must go **all the way back to the Source Document**.
- **The "Time Travel" Challenge**: Once we identify a consequential MacroMoment, we need to present the agent with the source document *as it existed then*. This requires "splicing" out any information that happened after the moment's timestamp.
- **The Moonshot Goal**: The end goal is "reconstructive spec generation"—the ability to delete a feature and rebuild it exactly as it was using only the spec.

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

### Technical Consideration 5: Document "Time Travel" Hooks
Since each data source (Cursor, GitHub, Discord) has a different shape, the logic to "extrapolate back" must be provider-specific. We propose adding a `timeTravel(doc, timestamp)` hook to each plugin:
- **Cursor Plugin**: Slice the `generations` array to remove any messages where `createdAt > timestamp`.
- **GitHub Plugin**: For Issues/PRs, filter the comments/events list to remove post-moment activity.
- **Benefit**: This keeps the engine generic. The engine just asks the plugin: "Give me the state of this doc at $T$."

## Consensus Point: The "Replay" Vision
The vision is a **Provenance-Backed Narrative**. Every line in the spec links back to the exact Moment/PR/Discussion that birthed it. It's not just a state; it's the *story* of the state.

## Consensus Building: The "Revision" Loop
How should the agent handle information that gets superseded (e.g., a "Decision" at $T=2$ that reverts a "Decision" at $T=1$)?
- **Proposed Logic**: The agent maintains a "Working Spec." When it sees a revision, it doesn't just overwrite; it updates the relevant section and ideally notes the *evolution* (e.g., "Pivot from X to Y because...").
- **Open Question**: How do we efficiently track the "Document ID -> Moment ID" mapping to ensure we pull the right version of the right document?

## Pivoted based on refined understanding of Moment Hierarchy
During our discussion, we corrected a misunderstanding regarding MicroMoments:
- **Correction**: MicroMoments are *not* raw text; they are first-level summaries. For speccing, we need to return to the **raw Source Documents** to get the necessary fidelity.
- **The Challenge**: We need to slice these source documents back to their state at time $T$.
- **Correction regarding Checklist**: The task to "Confirm MicroMoment schema" was based on this misunderstanding and is being superseded by research into "Document Time Travel".

### Technical Consideration 4: The Chronological Walk Algorithm (Restored)
To handle a branching graph while maintaining a strict "No Time Travel" invariant, we propose a Priority Queue (PQ) based traversal:
1. **Initialize**: Insert the root "Subject" moment into the PQ.
2. **Step**: 
   - Pop the moment $M$ with the earliest `created_at` from the PQ.
   - Insert all children of $M$ into the PQ.
   - Return $M$ to the agent.
3. **Benefit**: This ensures that even if different branches of work happened in parallel, the agent sees the events in the order they actually occurred.

## Alignment on Process: Reverting premature implementation
We acknowledged a jump to implementation before securing consensus on the technical design.
- **Action**: Reverted the addition of the `timeTravel` hook in `types.ts`.
- **Status**: We are remaining in the **Investigation & Consensus** phase until the design for the document "slicing" hooks and the PQ traversal is fully aligned.
- **Revised Task**: Focus on the specific heuristics for "Time Travel" slicing in the Cursor and GitHub plugins before drafting a final implementation plan.

### Revised Investigation Checklist
- [x] Investigate `src/app/engine/databases/momentGraph/index.ts` for existing batch retrieval performance.
- [x] Determine if we need a new database table `spec_replay_state` to store the Priority Queue for active runs.
- [x] Align with user on "Working Spec" vs "Changelog" revision style.
- [x] Acknowledge MicroMoments as summaries (pivoted to raw source docs).
- [/] Research plugin-specific "Time Travel" slicing logic (heuristics).

## [Action Taken] Correcting worklog protocol and aligning on investigation
We realized that our previous update replaced existing lines in the worklog, violating the "Append-Only" protocol. 

- **Correction**: We are strictly appending this narrative to maintain the chronological record.
- **Restoration of Intent**: The previous "Final Investigation Checklist" was meant to stay; the pivot from MicroMoments to Source Documents is an *evolution* of that investigation.
- **Status Check**: 
    - Code changes to `types.ts` have been reverted to keep us in the investigation phase.
    - We have clarified that MicroMoments are summaries, and we must "time travel" back to the raw source documents for high-fidelity speccing.
- **Next Step**: Investigate the specific heuristics required for the Cursor and GitHub plugins to slice their document shapes back to a timestamp $ (e.g., slicing conversation turns or filtering comments).

## [Investigated] Data-Source Specific "Time Travel" Heuristics
We have researched the existing plugins to determine how we can "extrapolate back" each document type to a specific timestamp $.

1. **Cursor Plugin**:
   - **Structure**: Conversations consist of multiple generations, each with an `events` array.
   - **Heuristic**: Walk the `generations` and discard any where the earliest event timestamp is $> T$.
2. **GitHub Plugin**:
   - **Structure**: Issues and PRs have a top-level `created_at` and a `comments` array.
   - **Heuristic**: If `issue.created_at > T`, the whole document is hidden. If `issue.created_at <= T`, filter the `comments` to only include those where `comment.created_at <= T`.
3. **Discord Plugin**:
   - **Structure**: Channel messages and threads contain an array of messages with `timestamp`.
   - **Heuristic**: Filter the message list to only include those where `timestamp <= T`.
4. **Default/Generic**:
   - **Heuristic**: Since these lack structured internal chronology, they are served as-is if their document-level `createdAt <= T`, otherwise they are hidden.

## The Moonshot: Reconstructive Spec Generation
We are aligning on a "Moonshot" goal for this feature:
- **Vision**: If a developer were to delete an entire feature's codebase, they should be able to point the Machinen agent at this spec and have it regenerated exactly as it was.
- **Why**: This proves the spec has sufficient narrative fidelity and rationale to serve as the true "Source of Truth" for the system.
