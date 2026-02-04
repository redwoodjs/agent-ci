# Worklog: The Unified Pipeline Architecture [2026-02-02]

## The Schism: Why We Failed
We initially architected Machinen with a "Two Pipeline" approach, believing that the requirements of Live execution (latency) and Simulation execution (throughput) were sufficiently different to warrant separate engines.

This was a mistake.

### The Missteps
1.  **The "Wrapper" Trap**: We thought we could share `Core` logic and just wrap it in different `Runner` adapters. In reality, the "Runner" logic (error handling, state transitions, retries) contains significant complexity. By duplicating this orchestration layer, we introduced **Logic Drift**. The Simulation runner behaved slightly differently than the Live runner, making backtests unreliable predictors of live behavior.
2.  **The "Simulation Engine" Silo**: By treating the Simulation as a separate product (with its own documentation and distinct `src/app/engine/simulation` directory), we psychologically and technically separated it from the "Real" system. Features added to Live weren't automatically available in Sim, and vice versa.
3.  **Infinite Retries (Thrashing)**: We failed to implement a proper Supervisor in the Simulation runner. When a job failed, the queue mechanism would retry it indefinitely (or until a vague timeout), causing "Zombie Tasks" and thrashing. We lacked a centralized Application-Level Retry counter.
4.  **Documentation Drift**: We maintained `system-flow.md` (Abstract) and `simulation-engine.md` (Implementation) separately. They drifted apart, with `system-flow` describing a theoretical "Adapter Pattern" that didn't match the messy reality of the "Runner" implementation.

## The Pivot: Unified Orchestrator Pattern
We are pivoting to a **Single Code Path** architecture. There is no longer a "Live Engine" and a "Simulation Engine". There is only **The Engine**.

### What It Is
1.  **Unified Orchestrator (`executePhase`)**: A single function that runs ALL phases. It handles the lifecycle: `Load -> Execute -> Persist -> Transition`.
2.  **Strategy Injection**: We handle the specific constraints of Live vs. Sim by injecting *Strategies*, not by writing different Runners.
    *   **StorageStrategy**: Live uses `NoOp` (speed); Sim uses `ArtifactDB` (checkpoints).
    *   **TransitionStrategy**: Live uses `Direct` (in-memory recursion); Sim uses `Queue` (async pacing).
3.  **Stateless Context**: We handle memory constraints (128MB Limit) not by streaming the whole graph, but by passing a `Context` object. Logic remains stateless but can query the DB for its specific dependencies (e.g., "Get me the parent issues for this PR").

### What It Isn't
1.  **It isn't a Business Logic Rewrite**: The domain logic (how we synth moments, how we link) remains in `src/app/pipelines/<phase>/engine/core`. It is just being freed from the legacy Runner boilerplate.
2.  **It isn't "Pure" Functional Programming**: We pragmatically accept side-effects (DB reads) via the `Context` to solve the scale problem. We do not attempt to load 10,000 documents into memory to be "pure".

## Goal State
*   **Zero Logic Drift**: If it runs in Sim, it works in Live.
*   **Zero Boilerplate**: Adding a phase means writing the `Core` logic. The Orchestrator handles the rest.
*   **Resilience**: Retries are handled centrally by the Orchestrator (counting on the Artifact), preventing infinite loops.

We are now proceeding to implement this `UnifiedRuntime` and refactor the phases to fit this new contract.
