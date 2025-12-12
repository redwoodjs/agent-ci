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
}

export async function callLLM(
  prompt: string,
  alias: LLMAlias = "slow-reasoning",
  options?: LLMOptions
): Promise<string> {
  const modelId = MODEL_MAP[alias];

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
  try {
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

    response = await (env.AI.run as any)(modelId, payload);
    const duration = Date.now() - start;
    console.log(`[llm] AI.run(${alias}) took ${duration}ms`);
    console.log(
      `[llm] Raw response type: ${typeof response}, keys: ${
        response && typeof response === "object"
          ? Object.keys(response).join(", ")
          : "N/A"
      }`
    );
    console.log(
      `[llm] Raw response structure: ${JSON.stringify(response, null, 2)}`
    );
  } catch (error) {
    console.error(`[llm] AI.run(${alias}) error:`, error);
    console.error(
      `[llm] Error type:`,
      error instanceof Error ? error.constructor.name : typeof error
    );
    console.error(
      `[llm] Error message:`,
      error instanceof Error ? error.message : String(error)
    );
    console.error(
      `[llm] Error stack:`,
      error instanceof Error ? error.stack : "no stack"
    );
    throw error;
  }

  // Handle different response structures
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
}
