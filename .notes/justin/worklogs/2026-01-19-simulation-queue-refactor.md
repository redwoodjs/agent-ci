## Simulation stalling on Cloudflare worker limits

The simulation pipeline currently runs sequentially (or with limited concurrency) within a single request context, often exceeding the 30s processing time limit on Cloudflare Workers. 

## Chose a queue-based deferral strategy

Instead of running the entire simulation loop in one request, we will transition to a queue-based model. Each unit of work (document, micro-batch, macro-synthesis) will be pushed to a Cloudflare Queue. This allows for horizontal scaling and respect for per-request time limits.

### Tasks
- [x] Identify queue injection points in the simulation runner.
- [x] Design the queue message schema.
- [x] Implement the `SimulationQueue` producer.
- [x] Implement the `SimulationQueue` consumer in the worker entry point.
- [x] Refactor `runPhase*` functions to optionally defer work.

## Implemented Log Auto-Scroll

Integrated a new `LogViewer` client component into the simulation and replay log pages. It automatically scrolls to the bottom on new log arrival unless the user manually scrolls up.

## Discovered Infinite Dispatch Loop in micro_batches

Observed that `advanceSimulationRunPhaseNoop` was enqueuing `simulation-advance` jobs whenever a phase returned `running`, even if no progress was made. Since `runPhaseMicroBatches` always re-dispatches document jobs when called without a specific key, this created a recursive loop that spammed the indexing queue.

## Fixing the loop

Refactoring `advanceSimulationRunPhaseNoop` to only enqueue next steps on state change (phase shift), and making `runPhaseMicroBatches` smarter about redundant dispatches.
