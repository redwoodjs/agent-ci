import { env } from "cloudflare:workers";
export type LLMModel = "gpt-oss-20b" | "gpt-oss-20b-cheap";

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
}

export async function callLLM(
  prompt: string,
  model: LLMModel = "gpt-oss-20b",
  options?: LLMOptions
): Promise<string> {
  const modelId =
    model === "gpt-oss-20b"
      ? "@cf/openai/gpt-oss-20b"
      : "@cf/meta/llama-3.1-8b-instruct"; // Use Llama 3.1 8B for "cheap" tasks

  const start = Date.now();
  const promptLength = prompt.length;
  const promptPreview = prompt.substring(0, 200).replace(/\n/g, " ");
  console.log(
    `[llm] Calling ${model} (${modelId}) with prompt length: ${promptLength} chars. Preview: ${promptPreview}...`
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
        } // GPT-OSS-20B uses 'input' and supports temperature/max_tokens
      : {
          prompt: prompt,
          ...(options?.temperature !== undefined && {
            temperature: options.temperature,
          }),
          ...(options?.max_tokens !== undefined && {
            max_tokens: options.max_tokens,
          }),
        }; // Llama uses 'prompt' and also supports these params

    response = await (env.AI.run as any)(modelId, payload);
    const duration = Date.now() - start;
    console.log(`[llm] AI.run(${model}) took ${duration}ms`);
    console.log(
      `[llm] Raw response type: ${typeof response}, keys: ${
        response && typeof response === "object"
          ? Object.keys(response).join(", ")
          : "N/A"
      }`
    );
  } catch (error) {
    console.error(`[llm] AI.run(${model}) error:`, error);
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
    // gpt-oss-20b uses OpenAI Responses API format: { response: string, usage: {...} }
    console.log(
      `[llm] Parsing gpt-oss response. Has response field: ${!!response?.response}, response type: ${typeof response?.response}`
    );
    if (response && typeof response.response === "string") {
      console.log(
        `[llm] Successfully extracted text from gpt-oss response. Length: ${response.response.length} chars`
      );
      return response.response;
    }
    // Fallback: check for old format (output array structure)
    const gptResponse = response as GPTOSSResponse;
    if (
      gptResponse?.output &&
      Array.isArray(gptResponse.output) &&
      gptResponse.output.length > 0 &&
      gptResponse.output[0].content &&
      Array.isArray(gptResponse.output[0].content) &&
      gptResponse.output[0].content.length > 0 &&
      typeof gptResponse.output[0].content[0].text === "string"
    ) {
      const text = gptResponse.output[0].content[0].text;
      console.log(
        `[llm] Successfully extracted text from gpt-oss response (legacy format). Length: ${text.length} chars`
      );
      return text;
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
