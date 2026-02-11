# Architecture Blueprint: Speccing Engine

## 2000ft View Narrative
The **Speccing Engine** is a reconstructive system that generates high-fidelity technical specifications by replaying the development narrative of a specific "Subject" (feature or initiative). 

Unlike traditional static documentation, the Speccing Engine treats the Knowledge Graph as a "time machine." It chronologically walks through the moments linked to a subject and provides a stateful, "time-locked" view of the evidence (PR diffs, chat logs, code snapshots) as it existed at that specific point in time.

The engine follows a **Unified Actor Model**: 
- **Machinen** is the "Brain" (stateful, time-locked data provider).
- **The IDE Agent** (Cursor, Antigravity) is the "Hands" (stateless, loop-driven executor).

## High-Level Structure
The engine consists of three main layers:
1.  **Stateful Storage (`SpeccingStateDO`)**: A dedicated SQLite-backed Durable Object for managing transient session states (Priority Queues, working drafts).
2.  **Chronological Runner**: A walker logic that pops moments from the PQ and slices source evidence by timestamp.
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
    - Engine pops the earliest moment $M$ from the PQ.
    - Engine triggers **Time Travel Hooks** in plugins to slice raw evidence (timestamp <= $M.createdAt$).
    - Engine pushes $M$'s children onto the PQ.
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

## Requirements, Invariants & Constraints
- **[Requirement] Absolute Time-Lock**: No data leakage from the future.
- **[Invariant] Stateless Agent**: The agent must not store session state locally; it must rely entirely on the `sessionId` and the backend PQ.
- **[Invariant] Namespace Affinity**: A speccing session is strictly bound to the namespace resolved at creation. All subsequent turns must operate within that same namespace.
- **[Constraint] Pure Web Access**: The engine must be reachable via standard `curl` to ensure compatibility across all IDE environments.
- **[Architecture Rule] Plugin-Driven Namespace Resolution**: The engine delegates project namespace resolution (e.g., `redwood:machinen`) to plugins (e.g., `redwood-scope-router`). Plugins inspect the `clientContext` (repository, remote) to map local development environments to canonical prefixes.
- **[Infrastructure Constraint] Vectorize Filter Latency**: Cloudflare Vectorize metadata indexes are **not retroactive**. If an index (e.g., `isSubject`) is created after vectors are inserted, those vectors will not be searchable via that filter until they are re-upserted.

## Learnings & Anti-Patterns
- **Avoid Bulk LLM Summarization**: Early versions attempted to summarize all moments at once. This led to hallucination and loss of detail. The shifted approach uses a turn-based replay to maintain high narrative fidelity.
- **Relational vs. Vector Subjects**: We moved away from a separate `SubjectDO` in favor of using the `moments` table as the source of truth, with `SUBJECT_INDEX` providing the semantic search capability. This prevents data duplication and keeps the graph unified.
