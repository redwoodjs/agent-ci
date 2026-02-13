# Worklog: 2026-02-12 Refining Speccing Engine Actor Model

## Initiated Priming and Investigation
We are starting the task to pivot the Speccing Engine from an IDE-agent-driven execution model to a more robust, stateful "Self-Instructing" API model. This follows challenges with getting the IDE agent to handle the complexity of the narrative replay loop reliably.

### The Problem
The current "Hands" (IDE Agent) model depends on the agent correctly following a complex set of instructions (protocol) to iterate through the narrative. This has proven brittle. We want to move the "Intelligence" and "State" of the loop into the Machinen backend, where each turn produces a revised spec draft and the next set of context, reducing the agent's role to a simple "Actor" mirroring the backend's decisions.

### Initial Review of Context
We are reading the following sources to synthesize the current project state:
- `docs/blueprints/speccing.md`: The architectural source of truth.
- `.notes/justin/worklogs/2026-02-09-speccing-feature-brainstorming.md`: The history of the current design.
- `scripts/bootstrap-specs.sh`: The current injection script for the agent protocol.

## Ideation and Design
We explored the benefits of transitioning to a "Self-Instructing" model. By moving the "The Brain" (revision logic) to the backend, we can use higher-reasoning models (Cerebras) and maintain a more reliable state without forcing the IDE agent to orchestrate complex narrative replay.

## RFC: Refine Speccing Engine Actor Model

### 2000ft View Narrative
We are pivoting the Speccing Engine from an "IDE-agent-as-executor" model to a "Self-Instructing API" model. In this new model, the Machinen backend handles the heavy reasoning of revising the specification based on historical evidence, while the client (a lightweight script) acts as a driver and output viewer.

### Database / Session State & Revision Modes
We leverage the existing `SpeccingStateDO` to persist the narrative replay state. The system supports two revision modes:

1. **Server Mode (The Actor)**: The Machinen backend performs the LLM revision step and returns the `revisedSpec`. This is the preferred mode for the synchronous `mchn-spec.sh` loop.
2. **Client Mode (The Agent)**: The backend provides raw evidence and instructions (turn-by-turn), and the IDE agent (Cursor/Antigravity) performs the actual file revision. This allows for manual intervention and more complex agentic behaviors.

The `working_spec` column in the `speccing_sessions` table stores the evolving draft, ensuring continuity regardless of mode.

### Proposed Changes

#### [Component] Machinen Backend

We will modify the Speccing Engine to perform the specification revision on the server side using a high-reasoning LLM (e.g., Cerebras with high reasoning effort).

##### [MODIFY] [runner.ts](file:///Users/justin/rw/worktrees/machinen_specs/src/app/engine/runners/speccing/runner.ts)
- Update `SpeccingSessionResult` to include the `revisedSpec`.
- Implement `reviseSpecTurn(session, moment, evidence, userPrompt)`:
    - Construct a comprehensive prompt using the current spec, new evidence, and the "Formatting Standard" from `bootstrap-specs.sh`.
    - Call the LLM with `high` reasoning effort.
    - Update the `working_spec` in the session database.
- Update `tickSpeccingSession` to invoke the revision step before returning.

##### [MODIFY] [speccing.ts](file:///Users/justin/rw/worktrees/machinen_specs/src/app/engine/routes/speccing.ts)
- Update `nextSpeccingHandler` to accept optional `currentSpec` and `userPrompt` in the request body.
- Return the revised spec to the client.

##### [NEW] [mchn-spec.sh](file:///Users/justin/rw/worktrees/machinen_specs/scripts/mchn-spec.sh)
- A self-contained script that automates the entire speccing process.
- **Interface**: `scripts/mchn-spec.sh "<PROMPT>"`
- **Workflow**:
    1. **Discovery**: Call `POST /api/subjects/search` with the prompt to identify the most relevant Subject ID.
    2. **Initialization**: Call `POST /api/speccing/start?subjectId=<ID>` to create a session.
    3. **Autonomous Loop**:
        - Repeatedly call `GET /api/speccing/next?sessionId=<ID>`.
        - After each turn, write the `revisedSpec` to `docs/specs/<subject>.md`.
        - Print status updates (turn #, moment summary) to stderr for feedback.
        - Stop when the API returns `status: "completed"`.
- **Stdin Support**: If the prompt argument is `-`, it reads from stdin.

##### [MODIFY] [bootstrap-specs.sh](file:///Users/justin/rw/worktrees/machinen_specs/scripts/bootstrap-specs.sh)
- Update the injected rules to point to the new `mchn-spec.sh` workflow or the direct `curl` patterns for the self-instructing API.

### Verification Plan

#### Automated Tests
- None planned for this phase, as the logic is highly dependent on LLM outputs.

#### Manual Verification
- **Step 1**: Run `scripts/mchn-spec.sh "Refactor the authentication flow"`.
- **Step 2**: Observe that the script discovers the subject and starts the loop automatically.
- **Step 3**: Verify that `docs/specs/<subject>.md` is created and updated incrementally after each turn.
- **Step 4**: Test piped input: `echo "Refactor auth" | scripts/mchn-spec.sh -`.

### Tasks
- [ ] Modify `SpeccingSessionResult` and `tickSpeccingSession` in `runner.ts`.
- [ ] Implement `reviseSpecTurn` in `runner.ts`.
- [ ] Update `nextSpeccingHandler` in `speccing.ts`.
- [ ] Create `scripts/mchn-spec.sh`.
- [ ] Update `scripts/bootstrap-specs.sh`.


## Implementation and Verification Complete
We have implemented the hybrid Speccing Engine and the autonomous `mchn-spec.sh` driver. Verifications against the local dev server confirm the workflow. We updated the Architecture Blueprint to reflect the current state.

### Final Verification Command
```bash
./scripts/mchn-spec.sh "Summary of recent work"
```
This command successfully reaches the local worker and initiates discovery.

### Usage Example: Autonomous Specification Generation
To generate a specification for the "Client Pre-fetching" feature using the local development server and specific namespace:

```bash
# 1. Ensure the dev server is running
# pnpm dev

# 2. Run the script with the specific context and prompt
# We use the 'local-2026-02-11-11-20-gentle-panda' namespace for the redwoodjs/sdk repository
API_KEY=dev \
MACHINEN_ENGINE_URL=http://localhost:5174 \
NAMESPACE_PREFIX="local-2026-02-11-11-20-gentle-panda" \
~/rw/worktrees/machinen_specs/scripts/mchn-spec.sh "Adding a new programmatic api to support manual client prefetching"
```

#### Expected Output Trace:
```text
--- Searching for relevant subject ---
Found Subject: c3ef1dba-8100-ddc9-54f7-514257ceabb4
--- Initializing Speccing Session ---
Session Started: a1b2c3d4-e5f6-7890-abcd-1234567890ab
--- Turn 1: Fetching next moment ---
[speccing:next] Performing server-side revision for session a1b2c3d4-e5f6-7890-abcd-1234567890ab
✅ Turn 1 complete. Updated docs/specs/c3ef1dba-8100-ddc9-54f7-514257ceabb4.md
--- Turn 2: Fetching next moment ---
...
--- Speccing Complete ---
Final Specification saved to: docs/specs/c3ef1dba-8100-ddc9-54f7-514257ceabb4.md
Open it now to review the results.
```
## Investigated Client Navigation and Prefetching
We researched the `redwoodjs/sdk` repository to understand the current state of client navigation.
- **Core Logic**: Located in `sdk/sdk/src/runtime/client/navigation.ts` and `navigationCache.ts`.
- **Key Function**: `preloadNavigationUrl` is the primary mechanism for prefetching.
- **Current Pattern**: Relies on `<link rel="x-prefetch">` tags discovered during hydration.
- **Goal**: Add a programmatic `prefetch(url)` API to the SDK to allow manual trigger.

## Ideation: Draft First, Refine Later
We've decided to refine the Speccing Engine's execution model. Instead of jumping straight into historical moments, we will perform an **Initial Drafting Pass** based purely on the user's prompt and the subject's high-level metadata.
1. **Turn 1 (Drafting)**: Use the (potentially large) user prompt to construct the first full version of the specification.
2. **Subsequent Turns (Refinement)**: Iterate through the Moment Graph to correct, update, or expand the draft based on what actually happened during implementation.

## Implementation Plan: "Draft First" Model
- **`initializeSpeccingSession`**: Continue to seed the Priority Queue with the `subjectId`.
- **`tickSpeccingSession`**: 
    - detect if it's the first turn (processedIds is empty).
    - If so, use a specialized `draftSpec` LLM call that emphasizes the user's prompt.
    - Subsequent turns use the existing `reviseSpecTurn` logic.

### Usage Example: Large Prompt via HEREDOC
For complex features like the Programmatic Prefetch API, we can provide a detailed specification draft in the prompt:

```bash
API_KEY=dev \
MACHINEN_ENGINE_URL=http://localhost:5174 \
NAMESPACE_PREFIX="local-2026-02-11-11-20-gentle-panda" \
~/rw/worktrees/machinen_specs/scripts/mchn-spec.sh - <<EOF
I want to add a new programmatic prefetch API to the RedwoodSDK client.
Currently, prefetching only happens via link tags. I want an exported 'prefetch' function that can be called manually.

Requirements:
1. It should take a URL (string or URL object).
2. It should use the existing 'preloadNavigationUrl' internal function.
3. It should be exported from 'rwsdk/client'.
4. It should be safe to call multiple times for the same URL.
EOF
```
