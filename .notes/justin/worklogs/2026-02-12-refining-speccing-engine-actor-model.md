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
## Implemented Streaming and Search Refinements
We finalized the streaming and search optimizations to address Cloudflare Worker CPU limits and subject discovery issues.

### Raw Text Streaming Protocol
- **Endpoint**: `/api/speccing/next/stream`
- **Mechanism**: Uses `ReadableStream` and `result.toTextStreamResponse()` for zero-buffer, low-overhead delivery.
- **Metadata**: Carried in `x-speccing-metadata` header to avoid JSON parsing in the body stream.
- **Persistence**: Final spec is persisted to `SpeccingStateDO` in the background after the stream completes.

### Resilient Subject Search
- **Diagnostic Logging**: Added detailed logs for vectorized match scores and filtered results.
- **Fuzzy Fallback**: If no subjects match the requested `namespacePrefix`, we retry the search globally (namespace-agnostic). This ensures subjects from "settled" default runs are always discoverable.

### CLI Enhancements
- **Streaming Driver**: `mchn-spec.sh` now uses `curl -N` and `tee` for real-time terminal output.
- **Local Sync**: The local MD file is iteratively updated at the end of each turn's stream.

## Verification
- **Real-time Specs**: Verified that the CLI shows the specification being built chunk-by-chunk.
- **Resilient Search**: Confirmed that `mchn-spec.sh` finds subjects even when the namespace is misconfigured or the subject is in the default namespace.

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

## Pivoting on Streaming: CPU vs Wall-clock
We discussed the 30s limit on Cloudflare Workers. While SSE/Streaming can run for up to 15 minutes of *wall-clock* time, the *CPU time* limit is much stricter (30s on Unbound, 50ms on Standard). 
- **Plan**: Use a raw `ReadableStream` of text for the specification body to minimize overhead. 
- **Protocol**: The script will receive metadata (Status/Moment) in HTTP headers or as a single initial JSON line, then the raw stream for the spec.

## Resolving Subject Search Failures
The user hit "No matching subject found" for a very relevant prompt.
- **Problem**: Namespace filtering might be too narrow if the simulation didn't tag exactly as expected.
- **Fix**: Implement a "Relaxed Fallback" in `searchSubjectsHandler`. If zero results are found in the specific namespace, we retry a global search across all subjects in the repository.
- **Diagnostics**: Added detailed logging of match scores and metadata to the backend.

## Finalized "Draft First" Example
We've updated the HEREDOC example to use a more natural phrasing that matches our refined search logic:

```bash
➜  machinen_specs git:(specs) API_KEY=dev \
MACHINEN_ENGINE_URL=http://localhost:5174/ \
NAMESPACE_PREFIX="local-2026-02-11-11-20-gentle-panda" \
npx tsx /Users/justin/rw/worktrees/machinen_specs/scripts/mchn-spec.ts \
"Identified full‑page reload issue for client‑side filters"       
```

You can use these docs as the "needles in the haystack" when running the simulation:
```
github/redwoodjs/sdk/issues/552/latest.json
github/redwoodjs/sdk/pull-requests/933/latest.json
github/redwoodjs/sdk/pull-requests/530/latest.json
discord/679514959968993311/1435702216315899948/threads/1373759907605516408/latest.json
```

## Final Optimization: Instant Spec File Availability
We addressed the "long wait" for the specification file by moving the session ID logic to the client.
- **Client-Side ID Generation**: The `mchn-spec.sh` script now slugifies the subject title locally and appends a random suffix. 
- **Zero-Latency File Creation**: The script `touch`es the `docs/specs/*.md` file immediately after discovery. This allows the user to open the file in their IDE before the initialization roundtrip to the server甚至 finishes.
- **Model Revert**: We tested `google-gemini-3-flash` for session naming to reduce startup latency, but the user found it slower than the default. We reverted back to `cerebras-gpt-oss-120b` for all naming tasks.
- **Live Streaming**: The CLI now uses `curl -N | tee "$SPEC_FILE"` to stream content directly into the final destination, providing a truly live, "typewriter" effect in the editor.

## Final Verification Results
- **Startup Latency**: Reduced from ~5s to <1s (from user perspective).
- **Streaming Reliability**: Raw text streams are stable and stay within Cloudflare CPU limits.
- **Search Robustness**: Global fallback successfully finds subjects regardless of namespace prefix alignment.
