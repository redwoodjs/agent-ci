# Architecture Blueprint: Speccing Engine

## 2000ft View Narrative
The **Speccing Engine** is a reconstructive system that generates high-fidelity technical specifications by replaying the development narrative of a specific "Subject" (feature or initiative). 

Unlike traditional static documentation, the Speccing Engine treats the Knowledge Graph as a "time machine." It chronologically walks through the moments linked to a subject and provides a stateful, "time-locked" view of the evidence (PR diffs, chat logs, code snapshots) as it existed at that specific point in time.

The engine follows a **Unified Actor Model**: 
- **Machinen** is the "Brain" (stateful, time-locked data provider).
- **The IDE Agent** (Cursor, Antigravity) is the "Hands" (stateless, loop-driven executor).

## Core Architecture
The engine consists of three main layers:
1.  **Stateful Storage (`SpeccingStateDO`)**: A dedicated SQLite-backed Durable Object for managing transient session states (Priority Queues, working drafts).
2.  **Evidence Reconstruction Layer**: A pipeline that fetches raw source documents from R2 and invokes plugin hooks (`timeTravel`, `reconstructContext`) to produce high-fidelity, time-locked evidence.
3.  **Self-Instructing API**: A REST interface that delivers both narrative data and the literal commands (instructions) the agent must execute next.

## System Flow
1.  **Discovery**: Agent searches for a subject via `POST /api/subjects/search`.
2.  **Initialization**: Agent calls `POST /api/speccing/start`.
    - Engine creates a `sessionId` in `SpeccingStateDO`.
    - **Namespace Binding**: Engine persists the resolved `momentGraphNamespace` in the session record.
    - Engine identifies the root moment and seeds the Priority Queue (PQ).
3.  **The Replay Turn**: Agent calls `GET /api/speccing/next`.
    - Engine loads the `sessionId` from `SpeccingStateDO`.
    - **Context Recovery**: Engine re-hydrates the `MomentGraphContext` using the persisted `momentGraphNamespace`.
    - Engine pops the earliest moment `M` from the PQ.
    - **High-Fidelity Fetch**: Engine retrieves the raw JSON source document `D` (linked to `M`) from R2.
    - **Evidence Slicing**: Engine triggers **Time Travel Hooks** in plugins to slice `D` by timestamp (`T <= M.createdAt`).
    - **Reconstruction**: Engine triggers **Reconstruction Hooks** to format the sliced data into a high-fidelity markdown evidence string.
    - Engine pushes `M`'s children onto the PQ.
    - Engine returns the context + `instruction` + `next_command`.
4.  **Completion**: When the PQ is empty, the engine returns `status: completed`.

## Database Schema
The engine uses the **SpeccingStateDO** for session management:

### `speccing_sessions`
| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | text (PK) | Unique session UUID. |
| `subject_id` | text | The root subject ID. |
| `priority_queue_json` | text | Ordered list of pending moment IDs. |
| `processed_ids_json` | text | List of integrated moment IDs. |
| `working_spec` | text | The current evolving markdown draft. |
| `moment_graph_namespace` | text | The qualified namespace string used to locate the Moment Graph. |
| `replay_timestamp` | text | Current high-water mark for time-locking. |
| `status` | text | `active`, `completed`, `failed`. |

## Behavior Spec

### 1. Subject Discovery
- **GIVEN** moments exist with `is_subject: true` in the Knowledge Graph.
- **WHEN** a semantic query is sent to `/api/subjects/search`.
- **THEN** the system returns ranked matches from the `SUBJECT_INDEX` (Vectorize).

### 2. Absolute Time-Locked Replay
- **GIVEN** a moment $M$ occurring at `T1`.
- **WHEN** the engine fetches evidence for $M$.
- **THEN** all raw documents (PR comments, Discord messages) are filtered to exclude any data with a timestamp `T > T1`.
- **AND** any code references must reflect the state of the repository at `T1`.

## API Reference

### `POST /api/subjects/search`
Discovery endpoint for finding subjects. Uses semantic search with metadata filtering.
- **Payload**: `{ "query": string, "namespace": string, "namespacePrefix": string }`
- **Response**: `{ "matches": Array<{ id, title, summary, score }> }`

### `POST /api/speccing/start`
Initializes a stateful speccing session.
- **Query Param**: `subjectId`
- **Payload**: `{ "namespace": string, "namespacePrefix": string }`
- **Response**: `{ "sessionId", "status", "instruction", "next_command" }`

### `GET /api/speccing/next`
Advances the replay loop.
- **Query Param**: `sessionId`
- **Response**: `{ "status", "moment", "evidence", "instruction", "next_command" }`

## Requirements, Invariants & Constraints
- **[Requirement] Absolute Time-Lock**: No data leakage from the future.
- **[Invariant] Stateless Agent**: The agent must not store session state locally; it must rely entirely on the `sessionId` and the backend PQ.
- **[Invariant] Namespace Affinity**: A speccing session is strictly bound to the namespace resolved at creation. All subsequent turns must operate within that same namespace.
- **[Constraint] Pure Web Access**: The engine must be reachable via standard `curl` to ensure compatibility across all IDE environments.
- **[Architecture Rule] Plugin-Driven Namespace Resolution**: The engine delegates project namespace resolution (e.g., `redwood:machinen`) to plugins.
- **[Infrastructure Constraint] Vectorize Metadata Indexing**: Metadata indices must be explicitly created on the Vectorize index for filtering (e.g., `isSubject`).

## Directory Mapping
- `src/app/engine/runners/speccing/`: Core replay logic and runner.
- `src/app/engine/databases/speccing/`: SQLite schema and session storage.
- `src/app/engine/routes/speccing.ts`: Speccing loop API handlers.
- `src/app/engine/routes/subjects.ts`: Discovery API handlers.
- `src/app/engine/plugins/`: High-fidelity `timeTravel` and `reconstructContext` implementations.

## Learnings & Anti-Patterns
- **Avoid Bulk LLM Summarization**: Turn-based replay prevents hallucination and maintains high fidelity.
- **Relational vs. Vector Subjects**: Unify subjects and moments in the `moments` table to prevent duplication, using Vectorize for ranked retrieval.
