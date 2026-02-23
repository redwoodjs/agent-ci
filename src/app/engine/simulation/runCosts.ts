import { getSimulationDb } from "./db";
import { SimulationDbContext } from "./types";
import { getPricingForAlias } from "../utils/pricing";
import { LLMAlias } from "../utils/llm";

export interface SimulationRunCostSummary {
  runId: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCallCount: number;
  totalCostStdDev: number;
  models: Array<{
    model: string;
    costUsd: number;
    callCount: number;
    inputTokens: number;
    outputTokens: number;
    stdDevInputTokens: number;
    stdDevOutputTokens: number;
  }>;
  buckets: Array<{
    model: string;
    inputBucket: string;
    outputBucket: string;
    callCount: number;
    avgInputTokens: number;
    stdDevInputTokens: number;
    avgOutputTokens: number;
    stdDevOutputTokens: number;
    totalCostUsd: number;
    avgCostUsd: number;
    stdDevCostUsd: number;
  }>;
}

export async function getSimulationRunCosts(
  context: SimulationDbContext,
  input: { runId: string },
): Promise<SimulationRunCostSummary> {
  const db = getSimulationDb(context);

  const costs = await db
    .selectFrom("simulation_run_llm_costs")
    .selectAll()
    .where("run_id", "=", input.runId)
    .execute();

  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCallCount = 0;
  let totalCostVar = 0;

  const modelMap = new Map<
    string,
    {
      costUsd: number;
      callCount: number;
      inputTokens: number;
      outputTokens: number;
      meanInput: number;
      m2Input: number;
      meanOutput: number;
      m2Output: number;
    }
  >();

  const buckets: SimulationRunCostSummary["buckets"] = [];

  for (const row of costs as any[]) {
    const alias = row.model_alias as LLMAlias;
    const pricing = await getPricingForAlias(alias);
    const pIn = pricing.inputCostPer1M / 1_000_000;
    const pOut = pricing.outputCostPer1M / 1_000_000;

    const cost = row.total_input_tokens * pIn + row.total_output_tokens * pOut;

    totalCostUsd += cost;
    totalInputTokens += row.total_input_tokens;
    totalOutputTokens += row.total_output_tokens;
    totalCallCount += row.call_count;

    const nB = row.call_count;

    // Variance of the cost for a single call in this bucket
    // Var(aX + bY) = a^2Var(X) + b^2Var(Y) + 2abCov(X,Y)
    // Assuming independence for simplicity in variance estimation
    const varIn = nB > 1 ? row.m2_input_tokens / (nB - 1) : 0;
    const varOut = nB > 1 ? row.m2_output_tokens / (nB - 1) : 0;
    const bucketVarCost = pIn * pIn * varIn + pOut * pOut * varOut;

    // Total variance contribution of this bucket (sum of variances of all calls in it)
    totalCostVar += nB * bucketVarCost;

    const existingModel = modelMap.get(row.model_alias) || {
      costUsd: 0,
      callCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      meanInput: 0,
      m2Input: 0,
      meanOutput: 0,
      m2Output: 0,
    };

    const nA = existingModel.callCount;
    const n = nA + nB;

    if (nA === 0) {
      existingModel.meanInput = row.mean_input_tokens;
      existingModel.m2Input = row.m2_input_tokens;
      existingModel.meanOutput = row.mean_output_tokens;
      existingModel.m2Output = row.m2_output_tokens;
    } else {
      // Parallel variance update (Chan et al.)
      const deltaIn = row.mean_input_tokens - existingModel.meanInput;
      existingModel.meanInput += deltaIn * (nB / n);
      existingModel.m2Input +=
        row.m2_input_tokens + deltaIn * deltaIn * ((nA * nB) / n);

      const deltaOut = row.mean_output_tokens - existingModel.meanOutput;
      existingModel.meanOutput += deltaOut * (nB / n);
      existingModel.m2Output +=
        row.m2_output_tokens + deltaOut * deltaOut * ((nA * nB) / n);
    }

    existingModel.costUsd += cost;
    existingModel.callCount += nB;
    existingModel.inputTokens += row.total_input_tokens;
    existingModel.outputTokens += row.total_output_tokens;
    modelMap.set(row.model_alias, existingModel);

    buckets.push({
      model: row.model_alias,
      inputBucket: row.input_bucket,
      outputBucket: row.output_bucket,
      callCount: row.call_count,
      avgInputTokens: row.mean_input_tokens,
      stdDevInputTokens: Math.sqrt(
        Math.max(0, nB > 1 ? row.m2_input_tokens / (nB - 1) : 0),
      ),
      avgOutputTokens: row.mean_output_tokens,
      stdDevOutputTokens: Math.sqrt(
        Math.max(0, nB > 1 ? row.m2_output_tokens / (nB - 1) : 0),
      ),
      totalCostUsd: cost,
      avgCostUsd: cost / nB,
      stdDevCostUsd: Math.sqrt(Math.max(0, bucketVarCost)),
    });
  }

  const models = Array.from(modelMap.entries()).map(([model, stats]) => {
    const n = stats.callCount;

    return {
      model,
      costUsd: stats.costUsd,
      callCount: stats.callCount,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      stdDevInputTokens: Math.sqrt(
        Math.max(0, n > 1 ? stats.m2Input / (n - 1) : 0),
      ),
      stdDevOutputTokens: Math.sqrt(
        Math.max(0, n > 1 ? stats.m2Output / (n - 1) : 0),
      ),
    };
  });

  return {
    runId: input.runId,
    totalCostUsd,
    totalInputTokens,
    totalOutputTokens,
    totalCallCount,
    totalCostStdDev: Math.sqrt(totalCostVar),
    models,
    buckets,
  };
}
