import { env } from "cloudflare:workers";
import { getHeuristicResponse } from "./heuristicLlm";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";

export type LLMAlias = "slow-reasoning" | "quick-cheap" | "gemini-3-flash";

// Map aliases to specific models for Cloudflare AI
const CF_MODEL_MAP: Record<string, string> = {
  "slow-reasoning": "@cf/openai/gpt-oss-20b",
  "quick-cheap": "@cf/meta/llama-3.1-8b-instruct",
};

// Map aliases to specific models for AI-SDK (Google)
const GOOGLE_MODEL_MAP: Record<string, string> = {
  "gemini-3-flash": "gemini-3-flash-preview",
};

interface GPTOSSResponse {
  output: Array<{
    content: Array<{
      text: string;
    }>;
  }>;
}

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
  const simulationMode = env.SIMULATION_HEURISTIC_MODE;
  if (
    typeof simulationMode === "string" &&
    (simulationMode === "1" || simulationMode === "true")
  ) {
    console.log(`[llm] Using HEURISTIC approximation for alias=${alias}`);
    return getHeuristicResponse(prompt, alias);
  }

  const logInfo = (msg: string, data?: any) => {
    if (options?.logger) {
      options.logger(msg, data);
    } else {
      console.log(`[llm] ${msg}`, data ? JSON.stringify(data) : "");
    }
  };

  // 2. Check if it's a Google model (handled by AI-SDK)
  const googleModelId = GOOGLE_MODEL_MAP[alias];
  if (googleModelId) {
    logInfo(`Calling AI-SDK Google model '${alias}' (${googleModelId})`);

    const apiKey = env.GOOGLE_AI_KEY;
    if (!apiKey) {
      throw new Error(`Missing GOOGLE_AI_KEY for alias '${alias}'`);
    }

    try {
      const google = createGoogleGenerativeAI({
        apiKey,
      });

      const { text } = await generateText({
        model: google(googleModelId),
        prompt: prompt,
        temperature: options?.temperature,
        maxTokens: options?.max_tokens,
      } as Parameters<typeof generateText>[0]);

      logInfo(`Successfully received response from Google. Length: ${text.length} chars`);
      return text;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logInfo(`AI-SDK Google call failed: ${msg}`, { error: msg });
      throw error;
    }
  }

  // 3. Handle Cloudflare AI models (legacy env.AI)
  const cfModelId = CF_MODEL_MAP[alias];
  if (!cfModelId) {
    throw new Error(`Unknown model alias: ${alias}`);
  }

  const start = Date.now();
  const promptLength = prompt.length;
  const promptPreview = prompt.substring(0, 200).replace(/\n/g, " ");

  logInfo(`Calling Cloudflare alias '${alias}' (${cfModelId}) with prompt length: ${promptLength} chars. Preview: ${promptPreview}...`);
  if (options) {
    logInfo(`Options: ${JSON.stringify(options)}`);
  }

  // Check for global reasoning effort override
  const reasoningEffortOverride = typeof env.LLM_REASONING_EFFORT === "string" ? env.LLM_REASONING_EFFORT.trim() : "";
  
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

  let response: any;
    const isGptOss = cfModelId.includes("gpt-oss");
    const payload = isGptOss
      ? {
          input: prompt,
          ...(options?.temperature !== undefined && {
            temperature: options.temperature,
          }),
          ...(options?.max_tokens !== undefined && {
            max_tokens: options.max_tokens,
          }),
          ...(options?.reasoning && {
            reasoning: options.reasoning,
          }),
        } // GPT-OSS-20B uses 'input' and supports temperature/max_tokens/reasoning
      : {
          prompt: prompt,
          ...(options?.temperature !== undefined && {
            temperature: options.temperature,
          }),
          ...(options?.max_tokens !== undefined && {
            max_tokens: options.max_tokens,
          }),
        }; // Llama uses 'prompt' and supports temperature/max_tokens

  const maxAttempts = 3;
  let lastError: unknown;
  const timeoutMs = options?.timeoutMs ?? 60_000; // Default to 60s

  options?.logger?.(`Starting LLM call to '${alias}' (${cfModelId})`, {
    cfModelId,
    alias,
    timeoutMs,
  });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (attempt > 0) {
        const backoffBase = 1000 * Math.pow(2, attempt - 1);
        const jitter = Math.floor(Math.random() * 250);
        const waitMs = backoffBase + jitter;
        
        const msg = `Retry attempt ${attempt + 1}/${maxAttempts}. Waiting ${waitMs}ms`;
        logInfo(msg, { attempt: attempt + 1, maxAttempts, waitMs });
        
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }

      logInfo(
        `Calling Cloudflare alias '${alias}' (${cfModelId}) attempt ${
          attempt + 1
        }/${maxAttempts}`
      );

      const runPromise = (env.AI as any).run(cfModelId, payload);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error("LLM Timeout: call took longer than 300s"));
        }, 300_000);
      });

      response = await Promise.race([runPromise, timeoutPromise]);
      const duration = Date.now() - start;
      logInfo(`AI.run(${alias}) took ${duration}ms`);
      
      // Success - break loop and parse
      if (cfModelId.includes("gpt-oss")) {
        // gpt-oss-20b returns a structured output with reasoning and message parts
        if (
          response?.output &&
          Array.isArray(response.output) &&
          response.output.length > 0
        ) {
          const messagePart = response.output.find(
            (part: any) => part.type === "message"
          );
          if (
            messagePart &&
            messagePart.content &&
            Array.isArray(messagePart.content) &&
            messagePart.content.length > 0 &&
            typeof messagePart.content[0].text === "string"
          ) {
            const text = messagePart.content[0].text;
            logInfo(
              `Successfully extracted text from gpt-oss message part. Length: ${text.length} chars`
            );
            return text;
          }
        }
        if (options?.logger) {
          options.logger(`Invalid gpt-oss response structure: ${JSON.stringify(response, null, 2)}`, { level: "error" });
        } else {
          console.error(
            `[llm] Invalid gpt-oss response structure:`,
            JSON.stringify(response, null, 2)
          );
        }
        throw new Error("Failed to parse LLM response from gpt-oss");
      } else {
        // Llama and other models often use this structure
        logInfo(
          `Parsing non-gpt-oss response. Has response field: ${!!response?.response}, response type: ${typeof response?.response}`
        );
        if (response && typeof response.response === "string") {
          logInfo(
            `Successfully extracted text from response. Length: ${response.response.length} chars`
          );
          return response.response;
        }
      }

      console.error(
        `[llm] Invalid response structure:`,
        JSON.stringify(response, null, 2)
      );
      throw new Error("Failed to parse LLM response");

    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      if (options?.logger) {
        options.logger(`Attempt ${attempt + 1}/${cfModelId} failed: ${msg}`, { level: "error", error: msg });
      } else {
        console.error(
          `[llm] Attempt ${attempt + 1}/${maxAttempts} failed:`,
          msg
        );
      }
      
      if (attempt + 1 >= maxAttempts) {
        if (options?.logger) {
           options.logger(`All ${maxAttempts} attempts failed.`, { level: "error" });
        } else {
           console.error(`[llm] All ${maxAttempts} attempts failed.`);
        }
        throw lastError;
      }
    }
  }

  throw new Error("Unexpected end of LLM call loop");
}
