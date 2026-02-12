# Architecture Blueprint: Speccing Engine

## 2000ft View Narrative
The **Speccing Engine** is a reconstructive system that generates high-fidelity technical specifications by replaying the development narrative of a specific "Subject" (feature or initiative). 

Unlike traditional static documentation, the Speccing Engine treats the Knowledge Graph as a "time machine." It chronologically walks through the moments linked to a subject and provides a stateful, "time-locked" view of the evidence (PR diffs, chat logs, code snapshots) as it existed at that specific point in time.

The engine follows a **Hybrid Actor/Agent Model**:
- **Machinen (Brain)**: Manages the narrative replay state (Priority Queue, Time-Locking).
- **Revision Modes**:
    - **Server Mode (The Actor)**: Machinen performs the specification revision on the server side using a high-reasoning LLM (Cerebras), returning the updated spec draft.
    - **Client Mode (The Agent)**: Machinen provides raw evidence and turn-by-turn instructions for an external agent (Cursor, Antigravity) to perform the revision locally.
- **Local Driver**: A lightweight script (`mchn-spec.sh`) orchestrates the autonomous loop, discovery, and file persistence.

## High-Level Structure
The engine consists of three main layers:
1.  **Stateful Storage (`SpeccingStateDO`)**: A dedicated SQLite-backed Durable Object for managing transient session states, including the evolving `working_spec`.
2.  **Chronological Runner**: A walker logic that pops moments from the PQ, handles document slicing, and optionally performs LLM-driven revisions.
3.  **Self-Instructing API**: A REST interface that delivers revised specs (Server Mode) or evidence snippets and instructions (Client Mode).

## System Flow
1.  **Discovery**: Driver searches for a subject via `POST /api/subjects/search` using a natural language prompt.
2.  **Initialization**: Driver calls `POST /api/speccing/start`.
    - Engine creates a `sessionId` in `SpeccingStateDO`.
    - Engine identifies the root moment and seeds the Priority Queue (PQ).
    - Engine stores the `revisionMode` (default: `server`).
3.  **The Replay Turn**: Driver calls `GET /api/speccing/next`.
    - Engine pops the earliest moment $M$ from the PQ.
    - Engine fetches raw document JSON from R2 (MACHINEN_BUCKET).
    - Engine invokes **Time Travel Hooks** in the matching Plugin to slice the raw JSON (timestamp <= $M.createdAt$).
    - **If Server Mode**:
        - Engine fetches the current `working_spec` from the DB.
        - Engine invokes a high-reasoning LLM with the context, evidence, and formatting standard.
        - Engine persists the `revisedSpec` back to `working_spec`.
    - **If Client Mode**:
        - Engine returns raw evidence and instructions for the agent.
    - Engine pushes $M$'s children onto the PQ.
    - Engine returns the `revisedSpec` (Server Mode) or evidence (Client Mode) + instruction + `next_command`.
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
| `revision_mode` | text | `server` or `client`. |
| `replay_timestamp` | text | Current high-water mark for time-locking. |
| `status` | text | `active`, `completed`, `failed`. |

## Behavior Spec

### 1. Subject Discovery
- **GIVEN** moments exist with `is_subject: true` in the Knowledge Graph.
- **WHEN** a semantic query is sent to `/api/subjects/search`.
- **THEN** the system returns ranked matches from the `MOMENT_INDEX` (Vectorize) filtered by `isSubject: true`.

### 2. Absolute Time-Locked Replay
- **GIVEN** a moment $M$ occurring at `T1`.
- **WHEN** the engine fetches evidence for $M$.
- **THEN** all raw documents are filtered to exclude any data with a timestamp `T > T1`.

### 3. Server-Side Revision (Self-Instructing)
- **GIVEN** a session in `server` mode.
- **WHEN** a `/next` call is processed.
- **THEN** the engine MUST generate a revised specification draft using a high-reasoning model (Cerebras) and return it to the client.

## Requirements, Invariants & Constraints
- **[Requirement] Absolute Time-Lock**: No data leakage from the future.
- **[Requirement] High-Fidelity Evidence**: Narrative replays must be grounded in raw document data, not just summaries.
- **[Invariant] Server-Side Intelligence**: In `server` mode, the backend is responsible for the specification's architectural integrity and formatting.
- **[Invariant] Stateless Driver**: The local script must not store session state locally beyond a `sessionId`; it must rely on the backend for the evolving spec and narrative order.
- **[Constraint] High-Reasoning Defaults**: Revisions should default to models with high reasoning efforts (e.g., Cerebras) to handle complex technical tradeoffs.

## Learnings & Anti-Patterns
- **Avoid Client-Side Orchestration**: Moving the replay loop logic to the IDE agent proved brittle. The self-instructing API ensures a more robust and predictable replay.
- **Unified Discovery**: We unified subject discovery on the main `MOMENT_INDEX` using metadata filters instead of maintaining a separate `SUBJECT_INDEX`.

