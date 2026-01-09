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

async function generateEmbeddingsBatch(
  texts: string[],
  env: Cloudflare.Env
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }
  const response = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
    text: texts,
  })) as { data: number[][] };

  if (
    !response ||
    !Array.isArray(response.data) ||
    response.data.length !== texts.length
  ) {
    throw new Error("Failed to generate batch embeddings");
  }
  return response.data;
}

export async function processChunkBatch(
  chunks: Chunk[],
  env: Cloudflare.Env
): Promise<void> {
  const batch = Array.isArray(chunks) ? chunks : [];
  if (batch.length === 0) {
    return;
  }

  try {
    const texts = batch.map((c) => c.content ?? "");
    const embeddings = await generateEmbeddingsBatch(texts, env);

    const vectorIds = await Promise.all(
      batch.map((chunk) => hashChunkId(chunk.metadata.chunkId))
    );
    const vectors = batch.map((chunk, i) => ({
      id: vectorIds[i]!,
      values: embeddings[i]!,
      metadata: chunk.metadata,
    }));

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await env.VECTORIZE_INDEX.insert(vectors);
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
    const firstId = batch[0]?.id ?? "unknown";
    const lastId = batch[batch.length - 1]?.id ?? "unknown";
    console.error(
      `[chunk-processor] Error processing chunk batch (${
        batch.length
      } chunks, ${firstId}..${lastId}): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    if (error instanceof Error) {
      console.error(`[chunk-processor] Stack: ${error.stack || "no stack"}`);
    }
    throw error;
  }
}

export async function processChunkJob(
  chunk: Chunk,
  env: Cloudflare.Env
): Promise<void> {
  try {
    await processChunkBatch([chunk], env);
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
