## Simulation stalling on Cloudflare worker limits

The simulation pipeline currently runs sequentially (or with limited concurrency) within a single request context, often exceeding the 30s processing time limit on Cloudflare Workers. 

## Chose a queue-based deferral strategy

Instead of running the entire simulation loop in one request, we will transition to a queue-based model. Each unit of work (document, micro-batch, macro-synthesis) will be pushed to a Cloudflare Queue. This allows for horizontal scaling and respect for per-request time limits.

### Tasks
- [ ] Identify queue injection points in the simulation runner.
- [ ] Design the queue message schema.
- [ ] Implement the `SimulationQueue` producer.
- [ ] Implement the `SimulationQueue` consumer in the worker entry point.
- [ ] Refactor `runPhase*` functions to optionally defer work.
