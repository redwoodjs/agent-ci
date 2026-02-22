import { SECRETS } from "@/secrets";
import type { LLMAlias } from "./llm";

export interface ModelPricing {
  inputCostPer1M: number;
  outputCostPer1M: number;
}

/**
 * Prices in USD per 1,000,000 tokens.
 */
let CACHED_PRICING: Record<string, ModelPricing> | null = null;
let CACHE_EXPIRY: number = 0;

const PRICING_MAPPING: Record<LLMAlias, string> = {
  "cerebras-gpt-oss-120b": "gpt-oss-120b",
  "cloudflare-gpt-oss-20b": "gpt-oss-20b",
  "cloudflare-llama-3.1-8b": "llama-3.1-8b",
  "google-gemini-3-flash": "gemini-3-flash",
};

export const DEFAULT_PRICING: Record<LLMAlias, ModelPricing> = {
  "cerebras-gpt-oss-120b": {
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.6,
  },
  "cloudflare-gpt-oss-20b": {
    inputCostPer1M: 0.05,
    outputCostPer1M: 0.15,
  },
  "cloudflare-llama-3.1-8b": {
    inputCostPer1M: 0.05,
    outputCostPer1M: 0.15,
  },
  "google-gemini-3-flash": {
    inputCostPer1M: 0.3,
    outputCostPer1M: 0.9,
  },
};

async function fetchDynamicPricing(): Promise<Record<
  string,
  ModelPricing
> | null> {
  const apiKey = SECRETS.AI_ARTIFICIAL_ANALYSIS_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch(
      "https://artificialanalysis.ai/api/v2/data/llms/models",
      {
        headers: {
          "x-api-key": apiKey,
        },
      },
    );

    if (!response.ok) {
      console.warn(`[pricing] Failed to fetch pricing: ${response.statusText}`);
      return null;
    }

    const data = (await response.json()) as any;
    const pricing: Record<string, ModelPricing> = {};

    // Process the models from the API
    if (Array.isArray(data.models)) {
      for (const model of data.models) {
        // AI SDK uses model.name or model.id, we'll try to normalize
        const modelId = model.model_id || model.name;
        if (modelId && model.pricing) {
          pricing[modelId.toLowerCase()] = {
            inputCostPer1M: parseFloat(model.pricing.input_1m || "0"),
            outputCostPer1M: parseFloat(model.pricing.output_1m || "0"),
          };
        }
      }
    }

    return pricing;
  } catch (error) {
    console.error("[pricing] Error fetching dynamic pricing:", error);
    return null;
  }
}

export async function getPricingForAlias(
  alias: LLMAlias,
): Promise<ModelPricing> {
  const now = Date.now();
  if (!CACHED_PRICING || now > CACHE_EXPIRY) {
    const dynamic = await fetchDynamicPricing();
    if (dynamic) {
      CACHED_PRICING = dynamic;
      CACHE_EXPIRY = now + 24 * 60 * 60 * 1000; // 1 day cache
    } else {
      // If fetch fails, don't clear old cache if it exists, just retry later
      // or fall back to defaults if no cache at all
      if (!CACHED_PRICING) {
        return DEFAULT_PRICING[alias];
      }
    }
  }

  const mappedModelId = PRICING_MAPPING[alias];
  const dynamicPricing = CACHED_PRICING?.[mappedModelId.toLowerCase()];

  return dynamicPricing || DEFAULT_PRICING[alias];
}

export async function calculateCost(
  alias: LLMAlias,
  inputTokens: number,
  outputTokens: number,
): Promise<number> {
  const pricing = await getPricingForAlias(alias);
  const inputCost = (inputTokens / 1_000_000) * pricing.inputCostPer1M;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputCostPer1M;
  return inputCost + outputCost;
}
