import { env } from "cloudflare:workers";
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
  model: LLMModel = "gpt-oss-20b"
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

  let response: any;
  try {
    const isGptOss = modelId.includes("gpt-oss");
    const payload = isGptOss
      ? { input: prompt } // GPT-OSS-20B uses 'input'
      : { prompt: prompt }; // Llama uses 'prompt'

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
    const gptResponse = response as GPTOSSResponse;
    console.log(
      `[llm] Parsing gpt-oss response. Has output: ${!!gptResponse?.output}, output length: ${
        gptResponse?.output?.length || 0
      }`
    );
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
        JSON.stringify(response, null, 2)
      );
      console.error(`[llm] Response structure check:`, {
        hasResponse: !!gptResponse,
        hasOutput: !!gptResponse?.output,
        outputIsArray: Array.isArray(gptResponse?.output),
        outputLength: gptResponse?.output?.length || 0,
        hasFirstContent: !!gptResponse?.output?.[0]?.content,
        contentIsArray: Array.isArray(gptResponse?.output?.[0]?.content),
        contentLength: gptResponse?.output?.[0]?.content?.length || 0,
        hasText:
          typeof gptResponse?.output?.[0]?.content?.[0]?.text === "string",
      });
      throw new Error("Failed to parse LLM response from gpt-oss");
    }
    const text = gptResponse.output[0].content[0].text;
    console.log(
      `[llm] Successfully extracted text from gpt-oss response. Length: ${text.length} chars`
    );
    return text;
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
