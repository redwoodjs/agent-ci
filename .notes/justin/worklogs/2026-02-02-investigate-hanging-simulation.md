# Investigate Hanging Simulation and Mock LLM Calls [2026-02-02]

## Initialized the investigation into the hanging simulation run
We are starting the investigation into why a 200-sample simulation run is hanging indefinitely. We also need to implement LLM mocking to speed up local testing. We started by reading the simulation engine blueprints and establishing this worklog.

## Drafted the implementation plan for LLM mocking and resilience fixes
We have drafted a plan to:
1. Add a `SIMULATION_LLM_MOCK` Wrangler variable.
2. Implement a mock response in `callLLM` when the flag is enabled. This will return deterministic summaries for `micro_batches` prompts.
3. Increase the zombie recovery timeout for the `micro_batches` phase from 5 minutes to 30 minutes to prevent redundant processing of large documents.

We are now awaiting approval before proceeding to implementation.

## Investigated the cause of the simulation hang and designed LLM mocking

### Simulation Hang Analysis
Evidence from `/tmp/sim.log` shows that documents are being dispatched multiple times (e.g., `cursor/conversations/e983f717-c2a1-4067-bb65-f35a5de3ac5f/latest.json` was dispatched 10 times). This aligns with a 5-minute zombie recovery timeout in `resiliency.ts` being triggered while the `micro_batches` worker is still processing a large document. The worker's 300s (5m) timeout matches the 5m recovery timeout, creating a race condition.

### LLM Mocking Strategy
We found that `callLLM` in `src/app/engine/utils/llm.ts` is the central point for AI calls. By introducing a `SIMULATION_LLM_MOCK` variable in `wrangler.jsonc`, we can intercept these calls. For `micro_batches`, we can detect the prompt structure and return standardized mock items (e.g., "S1|This is a mock summary of the document contents.").

## Work Task Blueprint: LLM Mocking and Resilience Fix (Actual Implementation)

### 1. Context
- **Problem**: Large documents trigger the 5-minute zombie recovery timeout in the simulation supervisor, causing redundant processing and preventing the run from advancing. Also, full LLM processing is too slow for rapid iteration with large samples.
- **Approach**: 
  - **Worker Heartbeat via Logger**: Thread the `r2Key` through the `SimulationLogger`. When the worker logs progress, the logger calls `addSimulationRunEvent` with the `r2Key`.
  - **Heartbeat Side-Effect**: `addSimulationRunEvent` touches the `updated_at` timestamp for that document in `simulation_run_documents`.
  - **Mock LLM calls**: Implement an LLM mocking layer controlled by an environment variable.

### 2. Breakdown of Performed Changes

#### [MODIFY] `wrangler.jsonc`
- Added `SIMULATION_LLM_MOCK` to `vars`.

#### [MODIFY] `src/app/engine/utils/llm.ts`
- Implemented `getMockResponse` and integrated it into `callLLM`.

#### [MODIFY] `src/app/engine/simulation/runEvents.ts`
- Updated `addSimulationRunEvent` to accept `r2Key` and touch `simulation_run_documents.updated_at`.

#### [MODIFY] `src/app/engine/simulation/logger.ts`
- Updated `createSimulationRunLogger` and logging methods to accept and pass `r2Key`.

#### [MODIFY] `src/app/pipelines/micro_batches/engine/simulation/runner.ts`
- Threaded `r2Key` from the `workUnit` into the logger creation.

#### [MODIFY] `worker-configuration.d.ts`
- Manually added `SIMULATION_LLM_MOCK` to the `Env` interface.

### 8. Actual Tasks Performed
- [x] Update `wrangler.jsonc` with mock variable
- [x] Implement `getMockResponse` logic in `llm.ts`
- [x] Implement `r2Key` heartbeat logic in `runEvents.ts`
- [x] Thread `r2Key` through `logger.ts` and `runner.ts`


## Revised the plan to use heartbeats instead of long timeouts
Based on your feedback that long timeouts are fragile, we have pivoted to a heartbeat mechanism. 

### Heartbeat Strategy
We will implement a liveness signaling mechanism where workers touch the `updated_at` timestamp of the document they are currently processing. This will happen before each LLM call and after major synchronous steps (like document splitting). This ensures the supervisor knows the worker is making progress, allowing us to keep the 5-minute recovery timeout for actual stalls/crashes.

### Updated Work Task Blueprint
[We have updated implementation_plan.md to reflect the Heartland mechanism and the corresponding task list.]

## Corrected the plan to align with the Resiliency Heartbeat protocol
I have re-read the `simulation-engine.md` blueprint and now realize that the 'Heartbeat' mechanism (the Supervisor Watchdog) is already a core part of the system. My error was in proposing a 'new' heartbeat system instead of simply ensuring our Handlers participate correctly in the existing one.

### Updated Robust Heartbeat Strategy
We will now have the Handler workers 'heartbeat' by touching the `updated_at` timestamp of the document they are processing whenever they log an event (via `addSimulationRunEvent`). This ensures that as long as the worker is logging progress, the existing Supervisor Watchdog will not incorrectly identify it as a zombie. This is the robust solution to the 'fragile timeout' problem.

## Rejection and Change of Mind [2026-02-02]
The previous implementation (Worker Heartbeat via Logger threading) has been **rejected**.

### Reasons for Rejection
1. **Implicit and Fragile**: Coupling heartbeats to the logging system is non-obvious and fragile. If a phase doesn't log frequently, or if logging is disabled, the heartbeat fails.
2. **Poor Planning**: This specific implementation (threading `r2Key` through the logger) was never explicitly documented in the approved blueprint/plan, leading to architectural surprise.
3. **Lack of Universality**: The solution was localized to `SimulationLogger` and doesn't provide a standard pattern that works intuitively across all simulation phases.
4. **Incorrect Abstraction**: Heartbeats (liveness signals) should be an explicit concern of the phase execution, not a side-effect of diagnostic logging.

### Resolution
We need a more robust and universal heartbeat mechanism that integrates directly into the phase lifecycle, independent of logging. This conversation is being closed, and a new one will start to design the correct abstraction.

## Analyzed handler orchestration and designed explicit heartbeat API
We have deep-dived into `simulation-worker.ts` and the various phase runners. We found that workers were previously relying on logging side-effects for liveness signaling, which was fragile. 

We have designed a new, explicit heartbeat pattern:
1.  **Context Expansion**: Update `SimulationDbContext` in `src/app/engine/simulation/types.ts` to include an optional `heartbeat: () => Promise<void>` property.
2.  **Worker Initialization**: In `src/app/engine/services/simulation-worker.ts`, we will instantiate a specific `heartbeat` closure for each job that touches the relevant document's `updated_at` timestamp.
3.  **Handler Adoption**: Handlers (like `micro_batches`) will call `context.heartbeat()` periodically, especially around high-latency operations like LLM calls.

This approach provides a clear, universal, and non-coupled liveness signal that keeps the Supervisor's zombie recovery at bay during intensive processing.


## Drafted the Work Task Blueprint for Universal Heartbeat
We have formalized the plan into a Work Task Blueprint. The core of the solution is an explicit `heartbeat` function injected into the `SimulationDbContext` at injection time (inside `simulation-worker.ts`). This allows handlers to signal liveness without coupling to the logging system.

### Work Task Blueprint: Universal Simulation Heartbeat & LLM Mocking

#### 1. Context
- **Problem**: Long-running simulation phases exceed the 5-minute zombie recovery timeout, leading to incorrect re-dispatching and hangs.
- **Approach**: Introduce an explicit `heartbeat` function into `SimulationDbContext`.
- **Design Decisions**: Explicit signaling ensures robustness and clarity.

#### 2. Breakdown of Planned Changes
- **Modify `SimulationDbContext`**: Add `heartbeat?: () => Promise<void>`.
- **Modify `simulation-worker.ts`**: Implement closure-based `heartbeat` using the `runId` and `r2Key`/`batchIndex` from the message.
- **Modify `micro_batches` handler**: Call `context.heartbeat()` during processing.
- **Update `wrangler.jsonc`**: Set `SIMULATION_LLM_MOCK` to `"1"`.

#### 3. Directory & File Structure
```text
src/app/
├── [MODIFY] engine/simulation/types.ts
├── [MODIFY] engine/simulation/runEvents.ts
├── [MODIFY] engine/services/simulation-worker.ts
└── [MODIFY] pipelines/micro_batches/engine/simulation/runner.ts
```

#### 4. Types & Data Structures
```typescript
export type SimulationDbContext = {
  env: Cloudflare.Env;
  momentGraphNamespace: string | null;
  heartbeat?: () => Promise<void>; // [NEW]
};
```

#### 5. Invariants & Constraints
- **Invariant**: Worker liveness is tied to `updated_at` freshness in the document/batch tables.
- **Constraint**: Heartbeats must be scoped to the specific work unit being processed.

#### 6. System Flow (Snapshot Diff)
- **Previous Flow**: Worker logs -> `addSimulationRunEvent` touches doc -> Supervisor checks.
- **New Flow**: Worker calls `context.heartbeat()` explicitly -> Touches doc -> Supervisor checks.

#### 7. Suggested Verification (Manual)
- Enable LLM mocking and verify speed.
- Add artificial delay + heartbeat and verify no zombie recovery happens.

#### 8. Tasks
- [ ] Update `SimulationDbContext` type
- [ ] Implement heartbeat factory in `simulation-worker.ts`
- [ ] Integrate heartbeat into `micro_batches` handler
- [ ] Update `wrangler.jsonc` for LLM mocking
- [ ] (Optional) Cleanup implicit heartbeats in `runEvents.ts`


## Designing the "Fast LLM" switch
Based on our discussion, we want a way to prioritize throughput over quality during simulations. We are introducing a `SIMULATION_USE_FAST_LLM` environment variable.

1.  **Fast LLM Switch**: When `SIMULATION_USE_FAST_LLM` is set to `"1"`, the `callLLM` utility will override all aliases (including `slow-reasoning`) to use the fastest available model in the Cloudflare Workers AI catalog (currently targeting `@cf/meta/llama-3.1-8b-instruct` or `@cf/google/gemma-2b-it`).
2.  **Addressing GBT-OSS**: While `gpt-oss-20b` is optimized for certain throughput patterns on Cloudflare, smaller instruction-tuned models like Llama-3 (8B) or Gemma (2B) generally offer lower latency per token for simple simulation tasks (summarization, analysis).

This switch will complement the existing `SIMULATION_LLM_MOCK` by providing a middle ground: real LLM processing but at maximum speed and minimum cost.


## Designed Heuristic Approximation Engine for extreme throughput
To address the need for maximum speed while maintaining "semi-realistic" results, we are introducing a heuristic mode.

1.  **Heuristic Mode**: Controlled by `SIMULATION_HEURISTIC_MODE`.
2.  **Implementation**: A new utility `heuristicLlm.ts` will handle the two primary simulation LLM tasks:
    - **Summarization**: Regex-based extraction of "important" sentences from chunks based on action keywords and author patterns.
    - **Classification**: Keyword-based classification of macro moments into kinds (problem, decision, solution).
3.  **Speed**: Since this runs in-process without network calls or LLM weights, it will be orders of magnitude faster than even Cerebras, enabling thousands of simulation steps per second.

This provides the "approximation in memory" we discussed, ensuring that even if and when Cerebras is "too slow" or "too expensive", we have a native-speed fallback that isn't just a static mock.


### Work Task Blueprint: Heuristic Approximation Engine & Fast LLM Switch

#### 1. Context
- **Problem**: Simulation throughput is limited by LLM latency. Even "fast" models can be a bottleneck for large-scale backfills or rapid validation cycles.
- **Approach**: Introduce two levels of optimization:
    1.  **Fast LLM Mode**: Use the fastest available models (e.g., Llama-3-8B).
    2.  **Heuristic Mode**: Use an in-process rule-based engine to extract "semi-realistic" summaries and classifications, bypassing network calls entirely.
- **Design Decisions**: 
    - Heuristics will use regex-based sentence extraction for micro-moments.
    - Classification will use keyword-based sentiment/intent analysis for macro-moments.
    - Standard `callLLM` remains the entry point to preserve API compatibility.

#### 2. Breakdown of Planned Changes
- **Implement `heuristicLlm.ts`**: Create the logic for summarization (extracting sentences with "suggest", "fix", etc.) and classification.
- **Modify `llm.ts`**: 
    - Check for overrides in order: Mock -> Heuristic -> Fast LLM.
    - Inject `SIMULATION_USE_FAST_LLM` and `SIMULATION_HEURISTIC_MODE` checks.
- **Modify `wrangler.jsonc`**: Add new environment variables.
- **Modify `worker-configuration.d.ts`**: Update types.

#### 3. Directory & File Structure
```text
src/app/
├── [NEW] engine/utils/heuristicLlm.ts
└── [MODIFY] engine/utils/llm.ts
wrangler.jsonc
worker-configuration.d.ts
```

#### 4. Types & Data Structures
No new shared types, but `LLMAlias` mappings will be overridden at runtime.

#### 5. Invariants & Constraints
- **Hierarchy of Overrides**:
    1. `SIMULATION_LLM_MOCK` (Literal fakes)
    2. `SIMULATION_HEURISTIC_MODE` (Dynamic heuristics)
    3. `SIMULATION_USE_FAST_LLM` (Real LLM, faster model)
- **Extractive Only**: Heuristics must only return content found in the prompt (or standardized Kind strings) to maintain "semi-realism".

#### 6. System Flow (Snapshot Diff)
- **Previous Flow**: `callLLM` -> `env.AI.run` -> Wait for network.
- **Heuristic Flow**: `callLLM` -> `getHeuristicResponse` -> Immediate return from local logic.

#### 7. Suggested Verification (Manual)
- Enable `SIMULATION_HEURISTIC_MODE` and run a simulation; verify summary text contains actually relevant snippets from the chunks.
- Enable `SIMULATION_USE_FAST_LLM` and verify logs show Llama-3-8B being used for "slow-reasoning" tasks.

#### 8. Tasks
- [ ] Create `heuristicLlm.ts`
- [ ] Implement summarization and classification heuristics
- [ ] Update `callLLM` logic and imports
- [ ] Update `wrangler.jsonc` and types


## Simplifying Simulation LLM Modes
Based on our discussion, we are stripping back the simulation LLM options to reduce complexity. We are removing the dedicated "Mock" and "Fast LLM" modes.

1.  **Removed `SIMULATION_LLM_MOCK`**: This was providing static, hardcoded responses.
2.  **Removed `SIMULATION_USE_FAST_LLM`**: This was forcing Llama-3-8B for all calls.
3.  **Retained `SIMULATION_HEURISTIC_MODE`**: This provides the "semi-realistic" native-speed approximation by extracting content directly from the input.
4.  **Retained Normal Mode**: Standard LLM calls to models specified in the registry.

The logic in `llm.ts` will now strictly check for Heuristic mode before proceeding to real LLM calls.

