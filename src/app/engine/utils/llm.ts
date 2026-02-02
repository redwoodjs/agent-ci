import { env } from "cloudflare:workers";

export type LLMAlias = "slow-reasoning" | "quick-cheap";

// Map aliases to specific models
const MODEL_MAP: Record<LLMAlias, string> = {
  "slow-reasoning": "@cf/openai/gpt-oss-20b",
  "quick-cheap": "@cf/meta/llama-3.1-8b-instruct",
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
  const modelId = MODEL_MAP[alias];

  // Check for simulation mock override
  if (
    typeof env.SIMULATION_LLM_MOCK === "string" &&
    (env.SIMULATION_LLM_MOCK === "1" || env.SIMULATION_LLM_MOCK === "true")
  ) {
    console.log(`[llm] Mocking LLM call for alias=${alias}`);
    return getMockResponse(prompt, alias);
  }

  const start = Date.now();
  const promptLength = prompt.length;
  const promptPreview = prompt.substring(0, 200).replace(/\n/g, " ");
  console.log(
    `[llm] Calling alias '${alias}' (${modelId}) with prompt length: ${promptLength} chars. Preview: ${promptPreview}...`
  );
  if (options) {
    console.log(`[llm] Options: ${JSON.stringify(options)}`);
  }

  let response: any;
    const isGptOss = modelId.includes("gpt-oss");
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

  options?.logger?.(`Starting LLM call to '${alias}' (${modelId})`, {
    modelId,
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
        console.log(`[llm] ${msg}`);
        options?.logger?.(msg, { attempt: attempt + 1, maxAttempts, waitMs });
        
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }

      console.log(
        `[llm] Calling alias '${alias}' (${modelId}) attempt ${
          attempt + 1
        }/${maxAttempts}`
      );

      const runPromise = (env.AI.run as any)(modelId, payload);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error("LLM Timeout: call took longer than 300s"));
        }, 300_000);
      });

      response = await Promise.race([runPromise, timeoutPromise]);
      const duration = Date.now() - start;
      console.log(`[llm] AI.run(${alias}) took ${duration}ms`);
      
      // Success - break loop
      // Success - break loop and parse
      if (modelId.includes("gpt-oss")) {
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
            console.log(
              `[llm] Successfully extracted text from gpt-oss message part. Length: ${text.length} chars`
            );
            return text;
          }
        }
        console.error(
          `[llm] Invalid gpt-oss response structure:`,
          JSON.stringify(response, null, 2)
        );
        throw new Error("Failed to parse LLM response from gpt-oss");
      } else {
        // Llama and other models often use this structure
        console.log(
          `[llm] Parsing non-gpt-oss response. Has response field: ${!!response?.response}, response type: ${typeof response?.response}`
        );
        if (response && typeof response.response === "string") {
          console.log(
            `[llm] Successfully extracted text from response. Length: ${response.response.length} chars`
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
      console.error(
        `[llm] Attempt ${attempt + 1}/${maxAttempts} failed:`,
        msg
      );
      
      options?.logger?.(`Attempt ${attempt + 1}/${maxAttempts} failed: ${msg}`, { 
        attempt: attempt + 1, 
        maxAttempts, 
        error: msg 
      });
      
      if (attempt + 1 >= maxAttempts) {
        console.error(`[llm] All ${maxAttempts} attempts failed.`);
        throw lastError;
      }
    }
  }

  throw new Error("Unexpected end of LLM call loop");
}

function getMockResponse(prompt: string, alias: LLMAlias): Promise<string> {
  // Detect phase based on prompt content
  if (prompt.includes("Summarize each sentence/item")) {
    // Micro-batch mocking
    // Prompt asks for: "S1|First summary\nS2|Second summary"
    return Promise.resolve(
      "S1|This is a mock summary for item 1.\nS2|This is a mock summary for item 2.\nS3|This is a mock summary for item 3."
    );
  }

  if (prompt.includes("Analyze the following summaries")) {
    // Macro-synthesis mocking
    return Promise.resolve(
      "Title: Mock Macro Update\n" +
        "Summary: This is a high-level mock summary of the activity.\n" +
        "Key Themes:\n- Mocking\n- Testing\n- Efficiency\n"
    );
  }

  // Default fallback
  return Promise.resolve("This is a generic mock LLM response.");
}
