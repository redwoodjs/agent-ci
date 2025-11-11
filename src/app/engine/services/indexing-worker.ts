import { indexDocument } from "../engine";
import { githubPlugin } from "../plugins";
import type { EngineContext } from "../types";
import { getIndexingState, updateIndexingState } from "../db";

interface IndexingMessage {
  r2Key: string;
}

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

async function deleteExistingVectors(
  documentId: string,
  env: Cloudflare.Env
): Promise<void> {
  const state = await getIndexingState(documentId);

  if (!state || !state.chunk_ids || state.chunk_ids.length === 0) {
    console.log(
      `[indexing-worker] No existing vectors to delete for ${documentId} (first time indexing)`
    );
    return;
  }

  const chunkIds = state.chunk_ids;

  for (let i = 0; i < chunkIds.length; i += 1000) {
    const batch = chunkIds.slice(i, i + 1000);
    await env.VECTORIZE_INDEX.deleteByIds(batch);
  }

  console.log(
    `[indexing-worker] Deleted ${chunkIds.length} existing vectors for document ${documentId} (from state)`
  );
}

export async function processIndexingJob(
  message: IndexingMessage,
  env: Cloudflare.Env
): Promise<void> {
  const { r2Key } = message;

  console.log(`[indexing-worker] Processing R2 key: ${r2Key}`);

  await deleteExistingVectors(r2Key, env);

  const context: EngineContext = {
    plugins: [githubPlugin],
    env,
  };

  const chunks = await indexDocument(r2Key, context);

  console.log(
    `[indexing-worker] Generated ${chunks.length} chunks for ${r2Key}`
  );

  const vectors = await Promise.all(
    chunks.map(async (chunk) => {
      const embedding = await generateEmbedding(chunk.content, env);
      const vectorId = await hashChunkId(chunk.metadata.chunkId);
      return {
        id: vectorId,
        values: embedding,
        metadata: chunk.metadata,
      };
    })
  );

  if (vectors.length > 0) {
    await env.VECTORIZE_INDEX.insert(vectors);
    const chunkIds = vectors.map((v) => v.id);
    console.log(
      `[indexing-worker] Inserted ${vectors.length} chunks into Vectorize`
    );
    console.log(
      `[indexing-worker] About to call updateIndexingState: chunkIds type=${typeof chunkIds}, isArray=${Array.isArray(
        chunkIds
      )}, length=${chunkIds.length}, sample=${JSON.stringify(
        chunkIds.slice(0, 3)
      )}`
    );

    const object = await env.MACHINEN_BUCKET.head(r2Key);
    if (object) {
      await updateIndexingState(r2Key, object.etag, chunkIds);
      console.log(
        `[indexing-worker] Updated indexing state for ${r2Key} with etag ${object.etag} and ${chunkIds.length} chunk IDs`
      );
    } else {
      console.warn(
        `[indexing-worker] Could not get R2 object head for ${r2Key}, skipping state update`
      );
    }
  } else {
    console.warn(
      `[indexing-worker] No vectors generated for ${r2Key}, skipping state update`
    );
  }

  console.log(`[indexing-worker] Completed indexing for ${r2Key}`);
}
