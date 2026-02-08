import { SECRETS } from "@/secrets";
import { env } from "cloudflare:workers";
import { getHeuristicResponse } from "./heuristicLlm";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createCerebras } from "@ai-sdk/cerebras";
import { generateText } from "ai";

const MODELS = {
  "slow-reasoning": { provider: "cerebras", id: "gpt-oss-20b" },
  "slow-reasoning-slow": { provider: "cloudflare", id: "@cf/openai/gpt-oss-20b" },
  "quick-cheap": { provider: "cloudflare", id: "@cf/meta/llama-3.1-8b-instruct" },
  "gemini-3-flash": { provider: "google", id: "gemini-3-flash-preview" },
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
}

export async function callLLM(
  prompt: string,
  alias: LLMAlias = "slow-reasoning",
  options?: LLMOptions
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
  const promptPreview = ((env as any).FULL_PROMPT_PREVIEWS ? prompt : prompt.substring(0, 200)).replace(/\n/g, " ");
  const logInfo = (msg: string, data?: any) => {
    if (options?.logger) {
      options.logger(msg, data);
    } else {
      console.log(`[llm] ${msg}`, data ? JSON.stringify(data) : "");
    }
  };

  // 2. Resolve model configuration
  const modelConfig = MODELS[alias] as ModelConfig;
  const modelId = modelConfig.id;

  if (modelConfig.provider === "google") {
    logInfo(`Calling AI-SDK Google model '${alias}' (${modelId}) with prompt length: ${promptLength} chars. Preview: ${promptPreview}...`);

    const apiKey = SECRETS.AI_GOOGLE_KEY;
    if (!apiKey) {
      throw new Error(`Missing AI_GOOGLE_KEY for alias '${alias}'`);
    }

    try {
      const google = createGoogleGenerativeAI({
        apiKey,
      });

      const { text } = await generateText({
        model: google(modelId),
        prompt: prompt,
        temperature: options?.temperature,
        maxTokens: options?.max_tokens,
      } as any);

      const duration = Date.now() - start;
      logInfo(`Successfully received response from Google. Length: ${text.length} chars. Duration: ${duration}ms`);
      return text;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logInfo(`AI-SDK Google call failed: ${msg}`, { error: msg });
      throw error;
    }
  }

  if (modelConfig.provider === "cerebras") {
    logInfo(`Calling AI-SDK Cerebras model '${alias}' (${modelId}) with prompt length: ${promptLength} chars. Preview: ${promptPreview}...`);

    const apiKey = SECRETS.AI_CEREBRAS_KEY;
    if (!apiKey) {
      throw new Error(`Missing AI_CEREBRAS_KEY for alias '${alias}'`);
    }

    try {
      const cerebras = createCerebras({
        apiKey,
      });

      const { text } = await generateText({
        model: cerebras(modelId),
        prompt: prompt,
        temperature: options?.temperature,
        maxTokens: options?.max_tokens,
      } as any);

      const duration = Date.now() - start;
      logInfo(`Successfully received response from Cerebras. Length: ${text.length} chars. Duration: ${duration}ms`);
      return text;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logInfo(`AI-SDK Cerebras call failed: ${msg}`, { error: msg });
      throw error;
    }
  }

  // 3. Handle Cloudflare AI models (AI-SDK Workers AI)
  const cfModelId = modelId;

  logInfo(`Calling Cloudflare alias '${alias}' (${cfModelId}) with AI-SDK and prompt length: ${promptLength} chars. Preview: ${promptPreview}...`);

  // Check for global reasoning effort override
  const reasoningEffortOverride = typeof SECRETS.LLM_REASONING_EFFORT === "string" ? SECRETS.LLM_REASONING_EFFORT.trim() : "";
  
  if (reasoningEffortOverride) {
    if (reasoningEffortOverride === "none") {
      logInfo(`[llm] Overriding reasoning effort to 'none' (removing reasoning options)`);
      if (options && options.reasoning) {
        options.reasoning = undefined;
      }
    } else if (["low", "medium", "high"].includes(reasoningEffortOverride)) {
      logInfo(`[llm] Overriding reasoning effort to '${reasoningEffortOverride}' (from env.LLM_REASONING_EFFORT)`);
      if (!options) {
        options = {};
      }
      if (!options.reasoning) {
        options.reasoning = {};
      }
      options.reasoning.effort = reasoningEffortOverride as "low" | "medium" | "high";
    }
  }

  try {
    const { createWorkersAI } = await import("workers-ai-provider");
    const workersai = createWorkersAI({
      binding: env.AI,
    });

    const isGptOss = cfModelId.includes("gpt-oss");
    
    // AI-SDK handles the model interaction.
    // We pass the model ID directly to the provider.
    const { text } = await generateText({
      model: workersai(cfModelId as any),
      prompt: prompt,
      temperature: options?.temperature,
      maxTokens: options?.max_tokens,
    } as any);

    const duration = Date.now() - start;
    logInfo(`Successfully received response from Cloudflare via AI-SDK. Length: ${text.length} chars. Duration: ${duration}ms`);
    return text;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logInfo(`AI-SDK Cloudflare call failed: ${msg}`, { error: msg });
    throw error;
  }
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
