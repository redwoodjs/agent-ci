import { indexDocument } from "../engine";
import { githubPlugin } from "../plugins";
import type { EngineContext } from "../types";
import type { Cloudflare } from "wrangler";

interface IndexingMessage {
  r2Key: string;
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
  const dummyEmbedding = await generateEmbedding("dummy", env);
  const queryResult = await env.VECTORIZE_INDEX.query(dummyEmbedding, {
    topK: 1000,
    returnMetadata: true,
    filter: {
      documentId: documentId,
    },
  });

  if (queryResult.matches.length > 0) {
    const idsToDelete = queryResult.matches.map((match) => match.id);
    await env.VECTORIZE_INDEX.deleteByIds(idsToDelete);
    console.log(
      `[indexing-worker] Deleted ${idsToDelete.length} existing vectors for document ${documentId}`
    );
  }
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
      return {
        id: chunk.metadata.chunkId,
        values: embedding,
        metadata: chunk.metadata,
      };
    })
  );

  if (vectors.length > 0) {
    await env.VECTORIZE_INDEX.insert(vectors);
    console.log(
      `[indexing-worker] Inserted ${vectors.length} chunks into Vectorize`
    );
  }

  console.log(`[indexing-worker] Completed indexing for ${r2Key}`);
}
