# 2026-02-22: Cost Estimation for Simulation Runs

## Investigation: Threading Context and Bucketing

We need to track LLM token usage (input/output) per simulation run, bucketed by size, and store this in the simulation database.

**Findings:**
1. **LLM Calls:** All LLM calls go through `callLLM` in `src/app/engine/utils/llm.ts`. The Vercel AI SDK `generateText` returns a `usage` object (`promptTokens`, `completionTokens`) which we can capture.
2. **Context Threading:** The user requested to "thread thru context". `PipelineContext` is passed to all phases via `executePhase`. However, many inner functions (like `synthesizeMicroMoments`) import `callLLM` directly rather than using `context.llm.call`. We can either:
   - Add `simulationId` to `PipelineContext` and pass it down explicitly through all function signatures to `callLLM`'s `options`.
   - Use `AsyncLocalStorage` from `node:async_hooks` to implicitly make `simulationId` available to `callLLM` without changing dozens of function signatures. (Will propose explicit threading as requested, but note ALS as an alternative).
3. **Bucketing:** The user strongly prefers size-based bucketing. We can define buckets (e.g., `<1k`, `1k-4k`, `4k-16k`, `16k+`) for both input and output tokens. A bucket key would look like: `cerebras-gpt-oss-120b::1k-4k::<1k`.
4. **Storage:** The simulation state is stored in SQLite (via Durable Object `EngineSimulationStateDO`). We need a new table `simulation_run_llm_costs` to store the aggregated stats per run and bucket.

## Draft Plan (RFC)

### 2000ft View Narrative
We will intercept the token usage statistics returned by the AI SDK inside `callLLM`. To associate these stats with a specific simulation run, we will explicitly thread the `simulationId` through the `PipelineContext` down to the `callLLM` options across all call sites.

Instead of recording every single LLM call (which could be thousands per run), we will aggregate the stats directly in the DB using "size-based bucketing". Calls with similar input and output token counts will be grouped together. This allows us to calculate meaningful statistics (mean, stdev) for different "shapes" of LLM calls without needing to explicitly label them by phase.

We will create a new database table `simulation_run_llm_costs` to store these aggregated buckets. `callLLM` will write directly to this table when a `simulationId` is provided.

Finally, we will build a Cost Analysis UI. On the simulation list page, we will show high-level estimates (cost per document, tokens per document). On the simulation detail page, we will link out to a dedicated Cost Analysis view that breaks down the costs by model, provider, and bucket, and extrapolates these costs to larger scales (100, 500, 1000, 5000 docs).

### Database Changes
**[NEW] Table:** `simulation_run_llm_costs`
- `run_id` (text, references `simulation_runs.run_id`)
- `model_alias` (text)
- `input_bucket` (text) - e.g., "1k-4k"
- `output_bucket` (text) - e.g., "<1k"
- `call_count` (integer)
- `total_input_tokens` (integer)
- `total_output_tokens` (integer)
- `total_duration_ms` (integer)
- `created_at` (text)
- `updated_at` (text)
- *Primary Key*: `(run_id, model_alias, input_bucket, output_bucket)`

### Behavior Spec
- **GIVEN** a simulation run is executing
- **WHEN** `callLLM` is invoked with a `simulationId`
- **THEN** the token usage is captured, bucketed by size, and upserted directly into `simulation_run_llm_costs` for that run.
- **GIVEN** a user views the simulation runs list
- **THEN** they see an estimated cost per document and token usage per document.
- **GIVEN** a user views a specific simulation run
- **THEN** they can navigate to a detailed Cost Analysis view showing extrapolated costs at scale.

### Implementation Breakdown
1. **[MODIFY]** `src/app/engine/simulation/migrations.ts`: Add migration `016_add_llm_costs` for the new table.
2. **[MODIFY]** `src/app/engine/simulation/types.ts`: Add the new table to `SimulationDatabase`.
3. **[NEW]** `src/app/engine/utils/pricing.ts`: Define cost per 1M tokens for each model alias.
4. **[MODIFY]** `src/app/engine/utils/llm.ts`: 
   - Update `LLMOptions` to accept `pipelineContext?: PipelineContext`.
   - Extract `usage` from `generateText` response.
   - Calculate size buckets (e.g., `<1k`, `1k-4k`, `4k-16k`, `16k+`).
   - If `pipelineContext.simulationId` is present, instantiate the simulation DB via `getSimulationDb(pipelineContext.env)` and write directly to the DB using an upsert query.
5. **[MODIFY]** `src/app/engine/runtime/types.ts`: Add `simulationId?: string` to `PipelineContext`.
6. **[MODIFY]** `src/app/engine/services/simulation-worker.ts`: Inject `simulationId: message.runId` into `pipelineContext`.
7. **[MODIFY]** All call sites of `callLLM` (e.g., `synthesizeMicroMoments`, `computeMicroMomentsForChunkBatch`, etc.): Update signatures to accept `pipelineContext` and pass it to `callLLM` options.
8. **[MODIFY]** `src/app/pages/audit/subpages/simulation-runs-page.tsx`: 
   - Fetch aggregated cost data for each run.
   - Display "Cost per doc" and "Tokens per doc" on the list view.
   - Add a link to the new Cost Analysis view for each run.
9. **[NEW]** `src/app/pages/audit/subpages/simulation-cost-analysis-page.tsx`: 
   - Build the detailed view showing bucket breakdowns.
   - Calculate and display extrapolations (100, 500, 1000, 5000 docs).
