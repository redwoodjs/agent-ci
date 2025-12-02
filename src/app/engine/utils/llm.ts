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
      : "@cf/openai/gpt-oss-20b";

  const start = Date.now();
  let response: any;
  try {
    response = await (env.AI.run as any)(modelId, {
      input: prompt,
    });
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

  console.log(`[llm] Response type:`, typeof response);
  console.log(
    `[llm] Response keys:`,
    response && typeof response === "object"
      ? Object.keys(response)
      : "not an object"
  );
  console.log(
    `[llm] Response preview:`,
    JSON.stringify(response).substring(0, 500)
  );

  if (!response) {
    throw new Error(
      `Failed to get LLM response: response is null or undefined`
    );
  }

  if (typeof response === "string") {
    return response;
  }

  if (typeof response === "object") {
    if (typeof response.response === "string") {
      return response.response;
    }

    const gptResponse = response as GPTOSSResponse;
    if (
      gptResponse.output &&
      Array.isArray(gptResponse.output) &&
      gptResponse.output.length > 0 &&
      gptResponse.output[0].content &&
      Array.isArray(gptResponse.output[0].content) &&
      gptResponse.output[0].content.length > 0 &&
      typeof gptResponse.output[0].content[0].text === "string"
    ) {
      return gptResponse.output[0].content[0].text;
    }
  }

  console.error(`[llm] Invalid response structure:`, JSON.stringify(response));
  throw new Error("Failed to parse LLM response");
}

