import { Chunk } from "../types";
import { env } from "cloudflare:workers";

async function hashChunkId(chunkId: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(chunkId);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hashHex.substring(0, 16);
}

async function generateEmbedding(
  text: string,
  env: Cloudflare.Env
): Promise<number[]> {
  const response = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
    text: [text],
  })) as { data: number[][] };

  if (
    !response ||
    !Array.isArray(response.data) ||
    response.data.length === 0
  ) {
    throw new Error("Failed to generate embedding");
  }

  return response.data[0];
}

export async function processChunkJob(
  chunk: Chunk,
  env: Cloudflare.Env
): Promise<void> {
  try {
    const embedding = await generateEmbedding(chunk.content, env);
    const vectorId = await hashChunkId(chunk.metadata.chunkId);

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
    await env.VECTORIZE_INDEX.insert([
      {
        id: vectorId,
        values: embedding,
        metadata: chunk.metadata,
      },
    ]);
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("Network connection lost")) {
          throw error;
        }
        if (attempt === maxAttempts) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, attempt * 200));
      }
    }
  } catch (error) {
    console.error(
      `[chunk-processor] Error processing chunk ${chunk.id}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    if (error instanceof Error) {
      console.error(`[chunk-processor] Stack: ${error.stack || "no stack"}`);
    }
    throw error;
  }
}
