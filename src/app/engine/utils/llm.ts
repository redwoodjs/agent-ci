import type { Cloudflare } from "rwsdk/types";

export type LLMModel = "gpt-oss-20b" | "gpt-oss-20b-cheap";

interface GPTOSSResponse {
  output: Array<{
    content: Array<{
      text: string;
    }>;
  }>;
}

export async function callLLM(
  prompt: string,
  env: Cloudflare.Env,
  model: LLMModel = "gpt-oss-20b"
): Promise<string> {
  const modelId =
    model === "gpt-oss-20b"
      ? "@cf/openai/gpt-oss-20b"
      : "@cf/meta/llama-3.1-8b-instruct"; // Use Llama 3.1 8B for "cheap" tasks

  const start = Date.now();
  let response: any;
  try {
    const isGptOss = modelId.includes("gpt-oss");
    const payload = isGptOss
      ? { input: prompt } // GPT-OSS-20B uses 'input'
      : { prompt: prompt }; // Llama uses 'prompt'

    response = await (env.AI.run as any)(modelId, payload);
    console.log(`[llm] AI.run(${model}) took ${Date.now() - start}ms`);
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
    const gptResponse = response as GPTOSSResponse;
    if (
      !gptResponse ||
      !gptResponse.output ||
      !Array.isArray(gptResponse.output) ||
      gptResponse.output.length === 0 ||
      !gptResponse.output[0].content ||
      !Array.isArray(gptResponse.output[0].content) ||
      gptResponse.output[0].content.length === 0 ||
      typeof gptResponse.output[0].content[0].text !== "string"
    ) {
      console.error(
        `[llm] Invalid gpt-oss response structure:`,
        JSON.stringify(response)
      );
      throw new Error("Failed to parse LLM response from gpt-oss");
    }
    return gptResponse.output[0].content[0].text;
  } else {
    // Llama and other models often use this structure
    if (response && typeof response.response === "string") {
      return response.response;
    }
  }

  console.error(`[llm] Invalid response structure:`, JSON.stringify(response));
  throw new Error("Failed to parse LLM response");
}
