import { SECRETS } from "@/secrets";
import { env } from "cloudflare:workers";
import { getHeuristicResponse } from "./heuristicLlm";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createCerebras } from "@ai-sdk/cerebras";
import { generateText } from "ai";
import type { PipelineContext } from "../runtime/types";
import { getSimulationDb } from "../simulation/db";
import { sql } from "rwsdk/db";

const MODELS = {
  "cerebras-gpt-oss-120b": { provider: "cerebras", id: "gpt-oss-120b" },
  "cloudflare-gpt-oss-20b": {
    provider: "cloudflare",
    id: "@cf/openai/gpt-oss-20b",
  },
  "cloudflare-llama-3.1-8b": {
    provider: "cloudflare",
    id: "@cf/meta/llama-3.1-8b-instruct",
  },
  "google-gemini-3-flash": { provider: "google", id: "gemini-3-flash-preview" },
} as const;

export type LLMAlias = keyof typeof MODELS;
type ModelConfig = (typeof MODELS)[LLMAlias];

export interface LLMOptions {
  temperature?: number;
  max_tokens?: number;
  reasoning?: {
    effort?: "low" | "medium" | "high";
    summary?: "auto" | "concise" | "detailed";
  };
  logger?: (message: string, data?: any) => void;
  timeoutMs?: number;
  pipelineContext?: PipelineContext;
}

export async function callLLM(
  prompt: string,
  alias: LLMAlias = "cerebras-gpt-oss-120b",
  options?: LLMOptions,
): Promise<string> {
  // 1. Check for simulation heuristic override (dynamic response)
  const simulationMode = SECRETS.SIMULATION_HEURISTIC_MODE;
  if (
    typeof simulationMode === "string" &&
    (simulationMode === "1" || simulationMode === "true")
  ) {
    console.log(`[llm] Using HEURISTIC approximation for alias=${alias}`);
    return getHeuristicResponse(prompt, alias);
  }

  const start = Date.now();
  const promptLength = prompt.length;
  const promptPreview = (
    (env as any).FULL_PROMPT_PREVIEWS ? prompt : prompt.substring(0, 200)
  ).replace(/\n/g, " ");
  const logInfo = (msg: string, data?: any) => {
    if (options?.logger) {
      options.logger(msg, data);
    } else {
      console.log(`[llm] ${msg}`, data ? JSON.stringify(data) : "");
    }
  };

  const modelConfig = MODELS[alias] as ModelConfig;
  const modelId = modelConfig.id;

  // Check for global reasoning effort override
  const reasoningEffortOverride =
    typeof SECRETS.LLM_REASONING_EFFORT === "string"
      ? SECRETS.LLM_REASONING_EFFORT.trim()
      : "";

  if (reasoningEffortOverride) {
    if (reasoningEffortOverride === "none") {
      logInfo(
        `[llm] Overriding reasoning effort to 'none' (removing reasoning options)`,
      );
      if (options && options.reasoning) {
        options.reasoning = undefined;
      }
    } else if (["low", "medium", "high"].includes(reasoningEffortOverride)) {
      logInfo(
        `[llm] Overriding reasoning effort to '${reasoningEffortOverride}' (from env.LLM_REASONING_EFFORT)`,
      );
      if (!options) {
        options = {};
      }
      if (!options.reasoning) {
        options.reasoning = {};
      }
      options.reasoning.effort = reasoningEffortOverride as
        | "low"
        | "medium"
        | "high";
    }
  }

  logInfo(
    `Logging alias '${alias}' (${modelId}) with prompt length: ${promptLength} chars. Preview: ${promptPreview}...`,
  );

  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (attempt > 0) {
        const backoffBase = 1000 * Math.pow(2, attempt - 1);
        const jitter = Math.floor(Math.random() * 250);
        const waitMs = backoffBase + jitter;

        logInfo(
          `Retry attempt ${attempt + 1}/${maxAttempts}. Waiting ${waitMs}ms`,
          { attempt: attempt + 1, maxAttempts, waitMs },
        );

        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }

      logInfo(
        `Calling alias '${alias}' (${modelId}) attempt ${attempt + 1}/${maxAttempts}`,
      );

      const callPromise = async () => {
        // 2. Execute model configuration
        let textResult = "";
        let usageResult: any | undefined;

        if (modelConfig.provider === "google") {
          logInfo(
            `Calling AI-SDK Google model '${alias}' (${modelId}) with prompt length: ${promptLength} chars. Preview: ${promptPreview}...`,
          );

          const apiKey = SECRETS.AI_GOOGLE_KEY;
          if (!apiKey) {
            throw new Error(`Missing AI_GOOGLE_KEY for alias '${alias}'`);
          }

          const google = createGoogleGenerativeAI({
            apiKey,
          });

          const { text, usage } = await generateText({
            model: google(modelId),
            prompt: prompt,
            temperature: options?.temperature,
            maxTokens: options?.max_tokens,
          } as any);

          textResult = text;
          usageResult = usage;
        } else if (modelConfig.provider === "cerebras") {
          logInfo(
            `Calling AI-SDK Cerebras model '${alias}' (${modelId}) with prompt length: ${promptLength} chars. Preview: ${promptPreview}...`,
          );

          const apiKey = SECRETS.AI_CEREBRAS_KEY;
          if (!apiKey) {
            throw new Error(`Missing AI_CEREBRAS_KEY for alias '${alias}'`);
          }

          const cerebras = createCerebras({
            apiKey,
          });

          const { text, usage } = await generateText({
            model: cerebras(modelId),
            prompt: prompt,
            providerOptions: {
              cerebras: {
                reasoningEffort: options?.reasoning?.effort ?? "medium",
              },
            },
            temperature: options?.temperature,
            maxTokens: options?.max_tokens,
          } as any);

          textResult = text;
          usageResult = usage;
        } else {
          // 3. Handle Cloudflare AI models (AI-SDK Workers AI)
          const cfModelId = modelId;

          logInfo(
            `Calling Cloudflare alias '${alias}' (${cfModelId}) with AI-SDK and prompt length: ${promptLength} chars. Preview: ${promptPreview}...`,
          );

          const { createWorkersAI } = await import("workers-ai-provider");
          const workersai = createWorkersAI({
            binding: env.AI,
          });

          const { text, usage } = await generateText({
            model: workersai(cfModelId as any),
            prompt: prompt,
            providerOptions: {
              "workers-ai": {
                // Workers AI doesn't have a direct reasoning effort flag yet in the provider,
                // but we map it if they support it in the future.
              },
            },
            temperature: options?.temperature,
            maxTokens: options?.max_tokens,
          } as any);

          textResult = text;
          usageResult = usage;
        }

        const duration = Date.now() - start;
        logInfo(
          `Successfully received response from ${modelConfig.provider}. Length: ${textResult.length} chars. Duration: ${duration}ms`,
        );

        if (usageResult && options?.pipelineContext?.simulationId) {
          try {
            logInfo(
              `Recording LLM cost for simulation ${options.pipelineContext.simulationId}: ${usageResult.promptTokens} in, ${usageResult.completionTokens} out`,
              { usage: usageResult },
            );
            await recordLLMCost(
              options.pipelineContext,
              alias,
              usageResult.promptTokens || 0,
              usageResult.completionTokens || 0,
              duration,
            );
          } catch (e) {
            logInfo(
              `Failed to record LLM cost for simulation ${options.pipelineContext.simulationId}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        } else {
          if (!usageResult) {
            logInfo(`No usageResult returned from ${modelConfig.provider}`);
          }
          if (!options?.pipelineContext?.simulationId) {
            logInfo(`No simulationId found in pipelineContext`);
          }
        }

        return textResult;
      };

      const timeoutMs = options?.timeoutMs ?? 300_000;
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              `LLM Timeout: call took longer than ${timeoutMs / 1000}s`,
            ),
          );
        }, timeoutMs);
      });

      return await Promise.race([callPromise(), timeoutPromise]);
    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      logInfo(`Attempt ${attempt + 1}/${maxAttempts} failed: ${msg}`, {
        error: msg,
      });

      if (attempt + 1 >= maxAttempts) {
        throw lastError;
      }
    }
  }

  throw new Error("Unexpected end of LLM call loop");
}

function getTokenBucket(tokens: number): string {
  if (tokens < 1000) return "<1k";
  if (tokens < 4000) return "1k-4k";
  if (tokens < 16000) return "4k-16k";
  return "16k+";
}

async function recordLLMCost(
  context: PipelineContext,
  alias: LLMAlias,
  promptTokens: number,
  completionTokens: number,
  durationMs: number,
): Promise<void> {
  const { simulationId, env } = context;
  if (!simulationId) return;

  const db = getSimulationDb({
    env,
    momentGraphNamespace: context.momentGraphNamespace ?? null,
  });
  const inputBucket = getTokenBucket(promptTokens);
  const outputBucket = getTokenBucket(completionTokens);
  const now = new Date().toISOString();

  await db
    .insertInto("simulation_run_llm_costs")
    .values({
      run_id: simulationId,
      model_alias: alias,
      input_bucket: inputBucket,
      output_bucket: outputBucket,
      call_count: 1,
      total_input_tokens: promptTokens,
      total_output_tokens: completionTokens,
      total_duration_ms: durationMs,
      mean_input_tokens: promptTokens,
      mean_output_tokens: completionTokens,
      m2_input_tokens: 0,
      m2_output_tokens: 0,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc
        .columns(["run_id", "model_alias", "input_bucket", "output_bucket"])
        .doUpdateSet({
          total_input_tokens: sql`total_input_tokens + ${promptTokens}`,
          total_output_tokens: sql`total_output_tokens + ${completionTokens}`,
          total_duration_ms: sql`total_duration_ms + ${durationMs}`,
          // Welford's Algorithm (Online Variance):
          // delta = x - mean
          // mean += delta / n
          // m2 += delta * (x - mean)
          mean_input_tokens: sql`mean_input_tokens + (${promptTokens} - mean_input_tokens) / (call_count + 1)`,
          m2_input_tokens: sql`m2_input_tokens + (${promptTokens} - mean_input_tokens) * (${promptTokens} - (mean_input_tokens + (${promptTokens} - mean_input_tokens) / (call_count + 1)))`,
          mean_output_tokens: sql`mean_output_tokens + (${completionTokens} - mean_output_tokens) / (call_count + 1)`,
          m2_output_tokens: sql`m2_output_tokens + (${completionTokens} - mean_output_tokens) * (${completionTokens} - (mean_output_tokens + (${completionTokens} - mean_output_tokens) / (call_count + 1)))`,
          call_count: sql`call_count + 1`,
          updated_at: now,
        }),
    )
    .execute();
}

/**
 * Robustly parses JSON from an LLM response, stripping markdown code blocks
 * or conversational fluff around the JSON object.
 */
export function parseLLMJson<T>(raw: string): T {
  let cleaned = raw.trim();

  // 1. Try to extract from markdown code blocks
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
  const match = cleaned.match(codeBlockRegex);
  if (match && match[1]) {
    cleaned = match[1].trim();
  }

  // 2. If still not looking like JSON, try to find the start/end braces
  if (!cleaned.startsWith("{") && !cleaned.startsWith("[")) {
    const startIdx = cleaned.indexOf("{");
    const endIdx = cleaned.lastIndexOf("}");
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      cleaned = cleaned.substring(startIdx, endIdx + 1);
    } else {
      // Try arrays
      const startArr = cleaned.indexOf("[");
      const endArr = cleaned.lastIndexOf("]");
      if (startArr !== -1 && endArr !== -1 && endArr > startArr) {
        cleaned = cleaned.substring(startArr, endArr + 1);
      }
    }
  }

  return JSON.parse(cleaned);
}
