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

## [Action Taken] Drafting RFC (Step 4)

### Context
We are implementing the "Speccing" engine, a system that regenerates technical specifications by replaying the historical development narrative of a "Subject" (Initiative/Feature). The core mechanics rely on a chronological traversal of the Moment Graph, pulling high-fidelity source documents (GitHub, Cursor, Discord), and "time-locking" them to match the state of the system at the time each moment occurred.

### Breakdown of Planned Changes
- **Core Abstractions**:
    - Update `Plugin` interface to include the `timeTravel` hook.
- **Plugin Heuristics**:
    - Implement `timeTravel` for `cursor.ts` (generation slicing).
    - Implement `timeTravel` for `github.ts` (comment/event filtering).
    - Implement `timeTravel` for `discord.ts` (message filtering).
- **Speccing Runner**:
    - [NEW] Create `src/app/engine/runners/speccing/runner.ts`.
    - Implement the Priority Queue (PQ) based chronological walk.
    - Implement the agentic loop: `Replay -> Propose Spec Change -> Reference Sources`.

### Directory & File Structure
```text
src/app/engine/
├── [MODIFY] types.ts
├── runners/
│   └── [NEW] speccing/
│       └── runner.ts
└── plugins/
    ├── [MODIFY] cursor.ts
    ├── [MODIFY] github.ts
    └── [MODIFY] discord.ts
```

### Types & Data Structures
```typescript
// In types.ts
export interface Plugin {
  // ...
  timeTravel?: (
    rawJson: any,
    timestamp: string,
    context: IndexingHookContext
  ) => Promise<any> | any;
}

// In speccingRunner.ts
export interface SpeccingState {
  workingSpec: string;
  processedMomentIds: Set<string>;
  priorityQueue: Moment[];
}
```

### Invariants & Constraints
1. **No Time Travel**: The agent MUST NOT receive any content from a document that was created after the `createdAt` timestamp of the current moment being replayed.
2. **Provenance-First**: Every proposed change to the "Working Spec" must cite a specific Moment ID and Source Document version as evidence.

### System Flow (Snapshot Diff)
**Current Flow**: Single-pass vector search -> LLM summary.
**New Flow**: Subject Root -> PQ Walk -> [For each Moment: Time-Locked Document Extraction -> LLM Revision Step] -> Final Spec.

### Suggested Verification (Manual)
1. Run the `SpeccingRunner` against a known historical feature branch.
2. Verify that the intermediate logs show the spec "evolving" as the replays proceed.
3. Compare the generated spec with the known end-state of the feature.

### Tasks
- [ ] [MODIFY] `src/app/engine/types.ts`: Add `timeTravel` hook.
- [ ] [MODIFY] `src/app/engine/plugins/cursor.ts`: Implement generation slicing.
- [ ] [MODIFY] `src/app/engine/plugins/github.ts`: Implement comment filtering.
- [ ] [MODIFY] `src/app/engine/plugins/discord.ts`: Implement message filtering.
- [ ] [NEW] `src/app/engine/runners/speccing/runner.ts`: Implement PQ walk and agentic loop.

## [Pivoted] Delegating the Agentic Loop to the IDE Agent (MCP)
Based on co-design discussion, we are shifting the "Agentic Loop" out of the Machinen runner and into the IDE (Cursor/Antigravity).

### The New Architecture: "Replay API + IDE Actor"
1. **Machinen (Backend)**: Becomes a **Stateful Replay Engine**. It manages the Priority Queue walk and high-fidelity, time-locked document slicing.
2. **MCP Server (Bridge)**: We expose Machinen's replay engine as an MCP server with tools like `get_next_replay_moment`.
3. **IDE Agent (Actor)**: The agent in the developer's console (Antigravity/Cursor) handles the actual file writing and turn-by-turn revisions.

### Benefits
- **Visibility**: The user sees the spec being built in their editor in real-time.
- **User-in-the-loop**: Replaying through the IDE allows the user to pause, ask questions, or steer the agent during the process.
- **Lower Lift**: Leverages existing agentic capabilities of the IDE for file operations and reasoning.

### Technical Requirement: Stateful Session Management
To support this, Machinen needs a way to track a "Speccing Session":
- We likely need a `spec_replay_state` table to store the PQ and processed moment IDs for an active session ID.
- The MCP tool will simply call `session.next()` and return the result.

### Integration Layer: Skills & Workflows
We will define an **Antigravity Skill** or **Workflow** (or an `agents.md` for general agents) that tells the agent:
- "Call the Machinen MCP tool to get the next moment."
- "Reconstruct the spec based on the source data provided."
- "Cite your sources."
- "Repeat until the stream is exhausted."

## [Challenge] why use MCP if we can just use Curl/CLI?
The user challenged the overhead and latency of MCP servers. If the IDE agent (Cursor/Antigravity) can already run commands, why wrap our API in an MCP tool?

### Our Analysis: The "Bridge" vs. the "Script"
1. **The MCP Argument (Encapsulation)**: A tool like `speccing_next` provides a structured schema (JSON-RPC) that the agent can "understand" without reading documentation. It hides auth headers and URL management.
2. **The CLI/Curl Argument (Low Latency & Control)**: Raw commands are faster, easier to debug, and don't require the agent to "discover" a server. The agent can just follow a `.agent/workflows/speccing.md` or an `agents.md` file.

### Decision: "CLI-First" Stateful Replay
We will prioritize making the **Machinen API** the "Source of State" but expose it via a **thin CLI utility** (or well-documented `curl` patterns) that the agent can execute.
- **Machinen API**: Holds the session state (`spec_replay_state`), handles the PQ walk, and slices the documents.
- **CLI Utility**: `mchn spec start <subjectId>` and `mchn spec next <sessionId>`.
- **IDE Agent**: Follows a workflow to call these commands and update the local spec.

### Can it be stateful?
Yes. Both MCP and CLI are stateless protocols, but the **Backend** (Machinen) is stateful. We pass a `sessionId` (a "ticket") back and forth. The API stores the "Cursor" (the PQ) for that session in the database.

## [Decision] Using AGENTS.md for Cross-Editor Portability
The user raised concerns about the portability of Antigravity-specific "Workflows". We have researched emerging standards and decided to adopt **AGENTS.md** as our primary "Instruction Layer".

### The Multi-Editor Strategy
1. **Universal Layer (AGENTS.md)**: We will maintain an `AGENTS.md` file at the project root. This file acts as a "README for AI" and defines the **Speccing Replay Protocol**. Any agent (Cursor, VS Code/Copilot, Antigravity) that reads this file will know how to call the Machinen CLI/API to perform a replay.
2. **Native Layer (Antigravity Workflows)**: We will still provide `.agent/workflows/speccing.md` for a "premium" experience in Antigravity, but its logic will strictly follow the protocol defined in `AGENTS.md`.
3. **Cursor Support**: Cursor agents natively read `AGENTS.md` (and `.cursorrules`), so our Speccing feature will be "discovered" by Cursor agents automatically if indexed.

### Standardizing the Loop Logic
The `AGENTS.md` will contain a section:
- **Speccing Protocol**:
    - "When asked to spec a feature, first call `mchn spec start <subjectId>`."
    - "Hold the `sessionId` in memory."
    - "Enter a loop: call `mchn spec next <sessionId>`, apply the provided time-locked context to update the spec, and cite the Moment ID."
    - "Stop when 'replay_exhausted' is true."

This ensures the feature is not trapped in one IDE while still providing a high-quality experience in our primary environment.

## [Pivoted] The "Self-Instructing API" (Universal Actor Pattern)
To solve the "Workflows are IDE-specific" and "Antigravity doesn't support AGENTS.md" challenges, we are moving the "Instruction Layer" into the **API Response** itself.

### The "Self-Driving" Handshake
Instead of teaching the agent the "Speccing Algorithm" via a config file (`AGENTS.md` or `speccing.md`), the Machinen API will **direct the agent turn-by-turn**.

1. **Step 1**: User asks: "mchn: spec out feature X".
2. **Step 2**: Agent runs `mchn spec start`.
3. **Step 3 (The Pivot)**: The API returns a JSON response containing:
    - `state`: The current session ID.
    - `instructions`: A clear markdown string for the agent: "I've initialized. Now run `mchn spec next` to see the first piece of evidence."
4. **Step 4**: The agent simply follows the `instructions` field in each response.
    - Each `speccing_next` result will include: "Here is the frozen document snippet at . Revise the spec at [Path] with these details, then call `mchn spec next` to continue."

### Why this scales
- **Zero Config**: No need for `AGENTS.md`, `.cursorrules`, or Antigravity Workflows to contain complex logic. The logic (the "The Brain") stays on the Machinen server.
- **Universal Portability**: Any agent that can run a CLI and read JSON can be the actor.
- **Robustness**: The server controls the flow, ensuring the "No Time Travel" invariant is never violated regardless of which IDE is used.

## [Investigated] Solving the "Bootstrapping Problem" (Discovery Strategy)
The user correctly identified a bootstrapping problem: if the agent doesn't have a standardized config file (`AGENTS.md`), how does it know to call `mchn spec start`?

### Three-Pronged Discovery
We will use a combination of "Discovery Signals" to ensure the agent finds the entry point:

1. **Static Discovery (Project Context)**:
   - We maintain a minimal, project-baseline "Rule" or "Context" file (e.g., `README.md` or a tiny project-level directive) that simply states:
     - "For speccing new work based on historical narrative, use the `mchn` CLI. Call `mchn spec start <subjectId>`."
2. **Tool Discovery (MCP Grounding)**:
   - The existing `search_machinen` MCP tool's documentation will be updated. When an agent searches for "narrative" or "speccing," the tool's description will explicitly suggest:
     - "To generate a technical spec from this subject's history, start a speccing session with `mchn spec start`."
3. **Trigger-Based Orchestration**:
   - In Antigravity or Cursor, the user often starts with "mchn: ...". This prompt triggers the agent to search for "mchn" in its current context (Files and Tools). Between the minimal project rule and the MCP tool hint, the agent will have a 99% hit rate for discovering the entry point.

Once the agent runs that **first** command, the "Self-Instructing API" takes over, and the bootstrapping problem is solved for the remainder of the session.

## [Final Alignment] The Hybrid Interface (Discovery vs. Execution)
We have refined the roles of MCP and CLI to address the user's concerns about latency and bootstrapping.

1. **MCP (The Discovery Layer)**:
   - **Role**: Entry point and "Capability Advertising".
   - **Why**: An agent is much more likely to "know" a capability exists if it's listed in its Tool palette (MCP).
   - **Action**: We provide a `speccing_start` tool. Calling this initialized the session and returns the **First Instruction**.

2. **CLI/mchn (The Execution Layer)**:
   - **Role**: The high-performance loop.
   - **Why**: Minimizes the JSON-RPC overhead for large document snippets.
   - **Action**: Once the session is started (via MCP or directly), the agent is instructed to use `mchn spec next` to drive the iteration.

3. **Rules/Directives (The Context Layer)**:
   - **Role**: Ensuring the agent knows where to look.
   - **Action**: We will include a minimal directive in `README.md` (or similar) that points the agent toward the speccing capability.

### Summary
The **discovery** can happen via MCP (automatic) or README (manual but robust). The **execution** happens via the `mchn` script to keep it fast. This "sneaky" bootstrapping ensures the agent finds the door, and the "Self-Instructing API" ensures it stays on the path.

## [Action Taken] The AGENTS.md Shim for Antigravity
The user suggested that we might be "shoehorning" `agents.md` and asked for a proper "shim" in Antigravity.

### The Shim Strategy
To ensure Antigravity (and other agents) follow the universal `AGENTS.md` without proprietary lock-in:
1. **Universal Layer**: `AGENTS.md` at the project root remains the single source of truth for the speccing protocol.
2. **Antigravity Shim**: We will create `.agent/rules/speccing-shim.md`. This file is natively supported by Antigravity and will contain a single instruction:
   - "For all speccing and narrative replay tasks, you MUST read and follow the instructions in `AGENTS.md`."
3. **Cursor Shim**: A similar entry in `.cursorrules` (or `.cursor/rules/speccing.mdc`) will do the same for Cursor.

### Why this works
- **No Shoehorning**: We aren't forcing the IDE to "support" `agents.md` natively. We are using the IDE's native "Rules" system to **point** at the standard.
- **Dry**: The complex "how-to" logic lives only in `AGENTS.md`. The shims are just pointers.

## [Correction] Cursor Natively Supports AGENTS.md
We corrected our understanding: **Cursor does support `AGENTS.md` natively**. 

### Revised Shim Strategy
- **Cursor**: No shim required. The agent will read `AGENTS.md` directly from the project root.
- **Antigravity**: Still needs the shim (`.agent/rules/speccing-shim.md`) because it does not yet support the global `AGENTS.md` standard.
- **Result**: We maintain a single source of truth (`AGENTS.md`) and only add boilerplate where the IDE hasn't yet caught up to the standard.

## [Simplified] Removing the MCP Bridge Entirely
The user questioned the necessity of the MCP server, even for discovery. If we have the "Shim" in `.agent/rules/` and the `README.md` hint, we can eliminate the MCP layer to reduce complexity and latency.

### The Pure CLI/API Flow
1. **Discovery**: The agent reads the local project rules (the "Shim" or README). It learns that the "Speccing Tool" is the `mchn` CLI.
2. **Execution**: The agent runs `mchn spec start`.
3. **Instruction**: The CLI response contains the next steps. The agent follows them.

### Why this is better
- **Zero Process Management**: No need to run an MCP server in the background.
- **Lower Latency**: Zero JSON-RPC/MCP overhead.
- **DRY**: We don't have to define the tool schema in both the CLI and the MCP server.

### Conclusion
We are ditching the MCP "Discovery" server. We will rely on the native IDE mechanisms (Rules/Context) to point the agent to the `mchn` command. The agent's first action will be a CLI call, and the API's response will handle the rest.

## [Final Evolution] The Pure JSON/Curl API (No-CLI Architecture)
The user proposed the ultimate simplification: **Removing the `mchn` CLI entirely**.

### Why "Pure Curl" is the Winner
1. **Zero Abstraction**: No custom scripts to maintain, index, or debug.
2. **Native for AI**: Agents are natively proficient at generating and parsing `curl` commands.
3. **Environment Agnostic**: Works perfectly in any shell, in any editor, without any local installation.

### The Self-Driving Curl Loop
1. **Discovery**: The "Shim" or README points the agent to a base `curl` command: `curl http://localhost:3000/api/speccing/start\?subjectId\=...`.
2. **Instruction**: Every JSON response includes:
   - `data`: The time-locked context.
   - `instruction`: "I've fetched the context for Moment [XYZ]. Now, update the spec at [Path] and run this next curl: `curl http://localhost:3000/api/speccing/next?sessionId=...`."
3. **Loop**: The agent executes the loop turn-by-turn.

### Conclusion: "Pure Web"
We are moving to a **pure web-service architecture**. Machinen provides the "Brain" and the "Replay Logic", and the IDE Agent acts as the "Hands" using standard web tools. Use of the `mchn` CLI is officially superseded by this `curl`-first model.

## RFC: Technical Specification for Machinen Speccing

### 2000ft View Narrative
The Machinen Speccing Engine is a reconstructive system designed to generate high-fidelity technical specifications by replaying the development narrative of a project feature or initiative. It enforces a strict "No Time Travel" invariant, ensuring that the generating agent only sees the information that was known at each historical point in time.

The system follows a "Pure Web + Universal Actor" model. Machinen acts as the stateful, time-locked "Brain," managing the moment graph traversal and high-fidelity source document slicing. The developer's IDE agent (Cursor, Antigravity, etc.) acts as the "Hands," driving the loop using standard `curl` commands and following self-instructing API responses. This architecture ensures cross-editor portability, zero-installation friction, and maximum performance.

### Context
- **Problem**: Traditional technical specifications often drift from reality because they capture the end-state but lose the rationale, pivot points, and "how-it-was-built" narrative.
- **Solution**: A system that chronologically walks a "Subject" in the Knowledge Graph, pulling raw evidence (PR diffs, chat logs) and "time-locking" them to match the state of the world at that moment.
- **Approach**: We utilize a Priority Queue (PQ) based traversal to handle branching histories and a dedicated Durable Object (`SpeccingStateDO`) to manage transient session state (PQ tracking, working spec drafts, and turn history).

### Database Changes (MANDATORY)
**Decision**: We use a dedicated **SpeccingState Durable Object** (`src/app/engine/databases/speccing/`).
**Rationale**: Speccing sessions involve transient, high-churn data like the Priority Queue and large, evolving drafts. Isolating this in a dedicated DO prevents bloat in the core `momentGraph` and aligns with the project's "Domain-Specific Storage" pattern (cf. `simulationState`).
> [!NOTE]
> **Subject Storage**: While we use a dedicated `SUBJECT_INDEX` (Vectorize) for discovery, the relational source of truth for subjects remains the `moments` table in `MomentGraphDO` (filtered by `is_subject: true`). The legacy `SubjectDO` is a stub and will be removed once the v8 migration is verified.

| Table | Column | Type | Description |
| :--- | :--- | :--- | :--- |
| **speccing_sessions** | id | text (PK) | Unique session identifier. |
| | subject_id | text | The root subject being replayed. |
| | priority_queue_json | text | JSON array of Moment IDs waiting to be processed. |
| | processed_ids_json | text | JSON array of Moment IDs already integrated. |
| | working_spec | text | The current evolved draft of the specification. |
| | replay_timestamp | text | The timestamp of the current moment being replayed (used for time-locking). |
| | status | text | 'active', 'completed', 'failed'. |
| | created_at | text | ISO timestamp. |
| | updated_at | text | ISO timestamp for TTL cleanup. |

### Behavior Spec
#### 1. Session Initialization
- **GIVEN**: A valid `subjectId` exists in the `moments` table.
- **WHEN**: A POST request is made to `/api/speccing/start?subjectId=ID`.
- **THEN**: The system initializes a `SpeccingStateDO`, populates the `priority_queue` with the root moment, and returns a `sessionId`.
- **AND**: The response includes a `curl` command for the `next` turn.

#### 2. Chronological Replay Loop
- **GIVEN**: An active session with unprocessed moments in the PQ.
- **WHEN**: A GET request is made to `/api/speccing/next?sessionId=ID`.
- **THEN**: The system pops the earliest unprocessed moment $M$.
- **AND**: It fetches raw source documents linked to $M$ and applies provider-specific "Time Travel" slicing (timestamp <= $M.createdAt$).
- **AND**: It returns the time-locked context, the moment summary, and the next `curl` command.

### API Specification

#### 1. Discovery API
Used to find relevant Subjects for speccing.
- **Endpoint**: `POST /api/subjects/search`
- **Alias**: `POST /debug/query-subject-index` (legacy compat)
- **Request Body**:
  ```json
  { "query": "string" }
  ```
- **Response**:
  ```json
  {
    "matches": [
      { "id": "string", "title": "string", "score": number, "summary": "string" }
    ]
  }
  ```

#### 2. Speccing Loop API
Stateful chronological walker.

##### **`POST /api/speccing/start`**
- **Query Params**: `subjectId` (string)
- **Response**:
  ```json
  {
    "sessionId": "string",
    "status": "active",
    "instruction": "Initial bootstrap instruction...",
    "next_command": "curl http://.../next?sessionId=..."
  }
  ```

##### **`GET /api/speccing/next`**
- **Query Params**: `sessionId` (string)
- **Response**:
  ```json
  {
    "sessionId": "string",
    "status": "active" | "completed",
    "moment": { "id": "string", "summary": "string", "createdAt": "string" },
    "evidence": [...],
    "instruction": "Detailed replay instruction for the agent.",
    "next_command": "curl http://.../next?sessionId=..."
  }
  ```

### Breakdown of Planned Changes
- **Database Layer**:
    - [NEW] `src/app/engine/databases/speccing/`: Create dedicated DO, migrations, and index. 
- **Core Engine (The Brain)**:
    - [NEW] `src/app/engine/runners/speccing/runner.ts`: Implement PQ-based chronological walker and "Self-Instructing" response logic.
    - [MODIFY] `src/app/engine/types.ts`: Update `Plugin` interface with the `timeTravel` hook.
- **Plugin Heuristics (Fidelity Slicing)**:
    - [MODIFY] `cursor.ts`, `github.ts`, `discord.ts`: Implement source-specific "time-locking" logic (e.g., generation/comment/message slicing).
- **Discovery & Orchestration**:
    - [NEW] `src/app/engine/routes/subjects.ts`: Implement `POST /api/subjects/search` for semantic discovery.
    - [MODIFY] `src/app/pipelines/materialize_moments/index.ts`: Add logic to embed and index `isSubject` moments into `SUBJECT_INDEX`.
- **Tooling (The Vehicle)**:
    - [NEW] `scripts/bootstrap-specs.sh`: A standalone POSIX-compliant script to inject the `AGENTS.md` and native IDE instructions. **Features local namespace detection via `git remote` heuristics.**

### Directory & File Structure
```text
.
├── scripts/
│   └── [NEW] bootstrap-specs.sh
└── src/app/engine/
    ├── databases/
    │   └── [NEW] speccing/
    │       ├── durableObject.ts
    │       ├── migrations.ts
    │       └── index.ts
    ├── runners/
    │   └── [NEW] speccing/
    │       └── runner.ts
    ├── routes/
    │   ├── [NEW] speccing.ts
    │   └── [NEW] subjects.ts
    └── plugins/
        ├── [MODIFY] cursor.ts
        ├── [MODIFY] github.ts
        └── [MODIFY] discord.ts
```

### Types & Data Structures
```typescript
export interface SpeccingSessionTable {
  id: string;
  subject_id: string;
  priority_queue_json: string; // Ordered by createdAt
  processed_ids_json: string;
  working_spec: string;
  status: 'active' | 'completed' | 'failed';
  created_at: string;
  updated_at: string;
}

export interface Plugin {
  // ...
  timeTravel?: (doc: any, timestamp: string) => Promise<any>;
}
```

### Invariants & Constraints
1. **Absolute Time-Lock**: No data leakage from the "future" relative to the current moment. All queries must respect the `replay_timestamp`.
2. **Stateless Protocols**: All session state is managed by the backend; the agent only carries the `sessionId`.
3. **Zero Maintenance Actor**: Instructions are delivered dynamically in API responses to avoid stale READMEs/rules.
4. **Autonomous Namespace Resolution**: The client resolves the project namespace locally (via `git`) to ensure project-agnosticity.

### System Flow (Snapshot Diff)
- **Previous Flow**: Subject Lookup -> Bulk LLM Summarization.
- **New Flow**: `/start` -> [ PQ Pop -> Time-Locked Slicing -> Agent Revision -> PQ Push Children ] -> `/finish`.

### Suggested Verification (Manual)
1. Run `bootstrap-specs.sh` in a test project and verify `.agent/rules/` and `AGENTS.md` injection.
2. Initialize a session: `curl -X POST "http://localhost:3000/api/speccing/start?subjectId=xyz"`
3. Drive the loop: `curl "http://localhost:3000/api/speccing/next?sessionId=abc"` and verify the `instruction` field.

### Tasks
- [ ] Implement `SpeccingStateDO` and migrations.
- [ ] Add `timeTravel` hooks to Cursor/GitHub plugins.
- [ ] Build the Speccing Runner (PQ walker).
- [ ] Create the Bash bootstrap script and instruction templates.


## [Prompt Design] Instruction Payloads & Spec Templates
To ensure high adherence and consistent output, we are defining the specific prompt and instruction payloads that will be used by the "Speccing Replay" loop.

### 1. The Bootstrap Payload (`AGENTS.md`)
This is the "Genesis Prompt" that tells the agent how to start.
```markdown
# Machinen Speccing Protocol
You are an expert technical writer and architect. Your task is to reconstruct a high-fidelity technical specification by replaying the development narrative of a specific "Subject".

## The Protocol
1. **Bootstrap**: Your first action must be to initialize the session.
   Execute: `curl -X POST "http://localhost:3000/api/speccing/start?subjectId=<ID>"`
2. **The Turn**: The response will contain a `sessionId`, a `moment` for you to process, and some `timeTravelContext` (raw evidence).
3. **The Action**: Use the evidence to update the technical specification at `docs/specs/<subject>.md`.
4. **The Loop**: Always follow the `instruction` field in the JSON response. It will provide the next `curl` command to execute.
5. **Completion**: When the response indicates that there are no more moments (`status: 'completed'`), finalize the document and notify the user.

## The Goal
Create a spec that passes the "Deletion Test". Your output must follow this mandatory structure:

- **2000ft View Narrative**: High-level architectural narrative (becomes the PR description).
- **Database Changes**: Schema changes and their rationale.
- **Behavior Spec**: Ground truth behaviors (GIVEN/WHEN/THEN).
- **Implementation Detail (The Pipes)**:
    - **Pipes**: Data flow steps.
    - **Breakdown**: Code changes (`[NEW]`, `[MODIFY]`, `[DELETE]`).
- **Directory & File Structure**: Tree view of files.
- **Types & Data Structures**: Snippets of types.
- **Invariants & Constraints**: Rules for the system.
- **System Flow (Snapshot Diff)**: Previous -> New flow delta.
- **Suggested Verification**: Commands for the human Advisor.
- **Tasks**: Granular checklist.
```

### 2. The Turn Payload (API `instruction` field)
Every `GET /api/speccing/next` call will return a response containing:
```json
{
  "sessionId": "...",
  "moment": { "id": "...", "summary": "...", "createdAt": "..." },
  "evidence": [ ... ],
  "instruction": "REPLAY TURN: Integrate the evidence above into the spec. Focus on the rationale for [Change X]. Once done, proceed to the next moment: `curl http://.../next?sessionId=...`",
  "status": "active"
}
```



## Completed Implementation of the Speccing Engine

We have finalized the implementation of the core Speccing Engine and its associated API. This completes Step 7 of the Bedrock Protocol.

### Accomplishments:
- **SpeccingStateDO**: Persistent session management via Durable Object SQLite.
- **SpeccingRunner**: Stateful replay loop with priority queue traversal.
- **Discovery API**: Semantic search for subjects using Vectorize.
- **Plugin Fidelity**: `timeTravel` hooks in Cursor, GitHub, and Discord for time-locked evidence slicing.
- **Bootstrap Script**: Autonomous project initialization and protocol enforcement.

We are now ready to begin verification.

## Verification Steps (Localhost)

We are using `http://localhost:5174` as the worker URL for local verification.

### 1. Discover Subjects
Find a subject to spec using semantic search:
```bash
export API_KEY="your_api_key"
export WORKER_URL="http://localhost:5174"
export NAMESPACE="redwoodjs/machinen"

curl -X POST "$WORKER_URL/api/subjects/search" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"Refactoring progress\", \"namespace\": \"$NAMESPACE\"}"
```

### 2. Start Speccing Session
Initialize the session with a `subjectId` (retrieved from step 1):
```bash
curl -X POST "$WORKER_URL/api/speccing/start?subjectId=YOUR_SUBJECT_ID" \
  -H "Authorization: Bearer $API_KEY"
```

### 3. Replay Narrative
Follow the `next_command` in the starting response or use:
```bash
curl -H "Authorization: Bearer $API_KEY" "$WORKER_URL/api/speccing/next?sessionId=YOUR_SESSION_ID"
```


## [Pivoted] Unifying Subject Discovery on MOMENT_INDEX

We decided to eliminate the dedicated `SUBJECT_INDEX` and instead unify all moment-related vector discovery on the `MOMENT_INDEX`.

### Rationale:
- **Redundancy**: Subjects are just root moments; maintaining two separate vector indexes for the same data is unnecessary.
- **Filtering**: Cloudflare Vectorize supports metadata filtering. We can achieve the same discovery by filtering for subjects in the main index.

### Mandatory Infrastructure Step:
> [!IMPORTANT]
> **Create Metadata Index**: Before this works in production, we MUST create a metadata index for the `isSubject` field on the `MOMENT_INDEX`.
> ```bash
> npx wrangler vectorize create-metadata-index moment-index-v8 \
>   --property-name='isSubject' \
>   --type='boolean'
> ```

### Plan Update:
- Modify `src/app/engine/routes/subjects.ts` to query `MOMENT_INDEX` with `{ isSubject: true }` filter.
- Modify `src/app/engine/databases/momentGraph/index.ts` to stop upserting to `SUBJECT_INDEX`.


## Verification Strategy: End-to-End Simulation Sandbox

To verify the Speccing Engine with high fidelity without polluting the main namespace, we will use a sandboxed "Simulation" flow.

### Strategy:
1. **Initialize Sandbox**: Deploy/Run the worker on `localhost:5174`.
2. **Create Simulation**: Use the `/admin/simulation/runs` endpoint to create a new simulation run.
3. **Capture Namespace Prefix**: Identify the generated `momentGraphNamespacePrefix` from the simulation run metadata (e.g., `sim-abc-123`).
4. **Environment Configuration**: 
   - Set `MOMENT_GRAPH_NAMESPACE_PREFIX` in `.dev.vars` to match the simulation prefix.
   - Alternatively, pass the prefix in discovery and bootstrap API calls.
5. **Execute Speccing Loop**:
   - Run `scripts/bootstrap-specs.sh` in a test repository.
   - Use the `curl` commands provided in the bootstrap output to search for subjects within the simulation namespace.
   - Proceed through the `/start` and `/next` loop as an agent would.

### Rationale:
By using a simulation prefix, we ensure that the Speccing Engine is replaying a controlled dataset (the "buggy cache" of the simulation) rather than the raw ingestion stream, allowing us to verify the transition from 'buggy' simulation state to 'clean' specification.


## [Verification] Narrative Replay via Simulation Namespace

To verify the Speccing Engine end-to-end, we will generate a fresh set of moments via a simulation run and then use the Speccing Engine to "replay" that specific simulated narrative.

### 1. Pre-requisites
- Worker running locally on `localhost:5174`.
- `API_KEY` set in `.dev.vars` and exported.

### 2. Generate a Simulation Run
Start a simulation to populate the Moment Graph with a fresh namespace.

```bash
export API_KEY="b54d6938d772ac7c760221db30e3fcd71b412f61c8f0740a3c43ba8e2aae9d24"
export WORKER_URL="http://localhost:5174"

# Create a simulation run (using redwood/machinen as base)
curl -X POST "$WORKER_URL/admin/simulation/runs" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"namespace": "redwoodjs/machinen", "description": "Speccing Verification Run"}'
```

### 3. Capture the Namespace Prefix
From the response above (or by listing runs), find the `prefix` (e.g., `prod-2026-02-10-...`).

```bash
# List recent simulation runs to find your prefix
curl -s -H "Authorization: Bearer $API_KEY" "$WORKER_URL/admin/simulation/runs" | jq '.runs[0].prefix'
```

### 4. Verify Discovery in the Sim Namespace
Now search for subjects *within* that simulation's namespace.

```bash
export SIM_NAMESPACE_PREFIX="<PREFIX_FROM_STEP_3>"
export BASE_NAMESPACE="redwoodjs/machinen"

curl -X POST "$WORKER_URL/api/subjects/search" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"query\": \"Refactoring\",
    \"namespace\": \"$BASE_NAMESPACE\",
    \"namespacePrefix\": \"$SIM_NAMESPACE_PREFIX\"
  }"
```

### 5. Replay the Session
Start the speccing session using a `subjectId` from the search results.

```bash
export SUBJECT_ID="<ID_FROM_SEARCH>"

curl -X POST "$WORKER_URL/api/speccing/start?subjectId=$SUBJECT_ID" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"namespace\": \"$BASE_NAMESPACE\",
    \"namespacePrefix\": \"$SIM_NAMESPACE_PREFIX\"
  }"
```

Then follow the `instruction` field in each JSON response to walk through the narrative turn-by-turn.

