import { indexDocument, createEngineContext } from "../index";
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
  if (!env.VECTORIZE_INDEX) {
    console.warn(
      `[indexing-worker] VECTORIZE_INDEX not available, skipping vector deletion`
    );
    return;
  }

  console.log(
    `[indexing-worker] Deleting existing vectors for ${documentId} via query`
  );

  // Generate a dummy embedding for the query
  // We use a zero vector of dimension 768 (standard for bge-base-en-v1.5)
  // Note: Vectorize requires a vector for query even if we only care about the filter
  const dummyVector = new Array(768).fill(0);

  let deletedCount = 0;
  let hasMore = true;
  let iteration = 0;

  // Loop to ensure we find and delete all chunks for this document
  while (hasMore) {
    iteration++;
    console.log(
      `[indexing-worker] Deletion iteration ${iteration}: Querying for vectors with documentId=${documentId}`
    );

    // Query for vectors with matching documentId
    // We ask for a large number (100) to minimize round trips
    // Note: With topK > 50, we must use returnMetadata: "indexed" instead of true
    const queryResult = await env.VECTORIZE_INDEX.query(dummyVector, {
      topK: 100,
      filter: { documentId },
      returnMetadata: "indexed", // Required for topK > 50
    });

    console.log(
      `[indexing-worker] Deletion query returned ${
        queryResult.matches?.length || 0
      } matches`
    );

    if (!queryResult.matches || queryResult.matches.length === 0) {
      hasMore = false;
      break;
    }

    const vectorIds = queryResult.matches.map((match) => match.id);
    console.log(
      `[indexing-worker] Deleting ${vectorIds.length} vectors: ${vectorIds
        .slice(0, 3)
        .join(", ")}${vectorIds.length > 3 ? "..." : ""}`
    );
    await env.VECTORIZE_INDEX.deleteByIds(vectorIds);
    deletedCount += vectorIds.length;
    console.log(
      `[indexing-worker] Deleted ${vectorIds.length} vectors (total so far: ${deletedCount})`
    );

    // If we got fewer results than we asked for, we've likely exhausted the list
    if (queryResult.matches.length < 100) {
      hasMore = false;
    }
  }

  if (deletedCount > 0) {
    console.log(
      `[indexing-worker] Deleted ${deletedCount} existing vectors for document ${documentId}`
    );
  } else {
    console.log(
      `[indexing-worker] No existing vectors found for ${documentId} (clean insert)`
    );
  }
}

export async function processIndexingJob(
  message: IndexingMessage,
  env: Cloudflare.Env
): Promise<void> {
  const { r2Key } = message;

  console.log(`[indexing-worker] Starting job for R2 key: ${r2Key}`);
  console.log(
    `[indexing-worker] Message structure: ${JSON.stringify(message)}`
  );

  try {
    console.log(
      `[indexing-worker] Step 1: Deleting existing vectors for ${r2Key}`
    );
    await deleteExistingVectors(r2Key, env);
    console.log(
      `[indexing-worker] Step 1 complete: Finished deleting existing vectors`
    );

    console.log(`[indexing-worker] Step 2: Creating engine context`);
    const context = createEngineContext(env, "indexing");
    console.log(
      `[indexing-worker] Step 2 complete: Engine context created with ${context.plugins.length} plugins`
    );

    console.log(`[indexing-worker] Step 3: Indexing document ${r2Key}`);
    const chunks = await indexDocument(r2Key, context);
    console.log(
      `[indexing-worker] Step 3 complete: Document indexed, got ${chunks.length} chunks`
    );

    if (chunks.length > 0) {
      console.log(
        `[indexing-worker] Sample chunk metadata: ${JSON.stringify(
          chunks[0].metadata,
          null,
          2
        )}`
      );
    }

    console.log(
      `[indexing-worker] Step 4: Generating embeddings for ${chunks.length} chunks`
    );

    // DEBUG: Log content stats by source
    const contentStats = chunks.reduce((acc, chunk) => {
      const source = chunk.metadata.source || "unknown";
      if (!acc[source]) {
        acc[source] = {
          count: 0,
          totalLength: 0,
          minLength: Infinity,
          maxLength: 0,
        };
      }
      acc[source].count++;
      acc[source].totalLength += chunk.content.length;
      acc[source].minLength = Math.min(
        acc[source].minLength,
        chunk.content.length
      );
      acc[source].maxLength = Math.max(
        acc[source].maxLength,
        chunk.content.length
      );
      return acc;
    }, {} as Record<string, { count: number; totalLength: number; minLength: number; maxLength: number }>);
    console.log(
      `[indexing-worker] DEBUG - Content stats by source: ${JSON.stringify(
        contentStats
      )}`
    );
    const vectors = await Promise.all(
      chunks.map(async (chunk, index) => {
        console.log(
          `[indexing-worker] Generating embedding ${index + 1}/${
            chunks.length
          } for chunk ${chunk.metadata.chunkId}`
        );
        console.log(
          `[indexing-worker] DEBUG - Chunk content (first 200 chars): ${chunk.content.substring(
            0,
            200
          )}`
        );
        console.log(
          `[indexing-worker] DEBUG - Chunk content length: ${chunk.content.length}`
        );
        const embedding = await generateEmbedding(chunk.content, env);
        console.log(
          `[indexing-worker] DEBUG - Generated embedding length: ${embedding.length}`
        );
        const vectorId = await hashChunkId(chunk.metadata.chunkId);
        console.log(
          `[indexing-worker] Generated embedding for chunk ${chunk.metadata.chunkId}, vectorId: ${vectorId}`
        );
        return {
          id: vectorId,
          values: embedding,
          metadata: chunk.metadata,
        };
      })
    );
    console.log(
      `[indexing-worker] Step 4 complete: Generated ${vectors.length} vectors`
    );

    if (vectors.length > 0) {
      console.log(
        `[indexing-worker] Step 5: Inserting ${vectors.length} vectors into Vectorize`
      );
      if (!env.VECTORIZE_INDEX) {
        console.warn(
          `[indexing-worker] VECTORIZE_INDEX not available, skipping vector insertion. Generated ${vectors.length} vectors but cannot store them.`
        );
        return;
      }

      console.log(
        `[indexing-worker] Calling VECTORIZE_INDEX.insert with ${vectors.length} vectors`
      );

      // DEBUG: Log sample vector metadata before insertion
      if (vectors.length > 0) {
        console.log(
          `[indexing-worker] DEBUG - Sample vector to insert: ${JSON.stringify(
            {
              id: vectors[0].id,
              metadata: vectors[0].metadata,
              valuesLength: vectors[0].values.length,
            },
            null,
            2
          )}`
        );
      }

      await env.VECTORIZE_INDEX.insert(vectors);

      // DEBUG: Verify insertion by querying immediately
      if (vectors.length > 0 && vectors[0].metadata.source === "cursor") {
        const testVector = new Array(768).fill(0); // Dummy vector for query
        const verifyResponse = await env.VECTORIZE_INDEX.query(testVector, {
          topK: 10,
          returnMetadata: true,
          filter: { documentId: vectors[0].metadata.documentId } as any,
        });
        console.log(
          `[indexing-worker] DEBUG - Verification query after insert: Found ${verifyResponse.matches.length} matches for documentId ${vectors[0].metadata.documentId}`
        );
        if (verifyResponse.matches.length > 0) {
          console.log(
            `[indexing-worker] DEBUG - Verification match metadata: ${JSON.stringify(
              verifyResponse.matches[0].metadata as any
            )}`
          );
        }
      }
      const chunkIds = vectors.map((v) => v.id);
      console.log(
        `[indexing-worker] Step 5 complete: Successfully inserted ${vectors.length} chunks into Vectorize`
      );
      console.log(
        `[indexing-worker] About to call updateIndexingState: chunkIds type=${typeof chunkIds}, isArray=${Array.isArray(
          chunkIds
        )}, length=${chunkIds.length}, sample=${JSON.stringify(
          chunkIds.slice(0, 3)
        )}`
      );

      console.log(`[indexing-worker] Step 6: Updating indexing state`);
      const object = await env.MACHINEN_BUCKET.head(r2Key);
      if (object) {
        // Note: We still pass chunkIds to updateIndexingState for now to keep the signature valid,
        // but we no longer rely on them for deletion.
        await updateIndexingState(r2Key, object.etag, chunkIds);
        console.log(
          `[indexing-worker] Step 6 complete: Updated indexing state for ${r2Key} with etag ${object.etag}`
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

    console.log(
      `[indexing-worker] Successfully completed indexing for ${r2Key}`
    );
  } catch (error) {
    console.error(
      `[indexing-worker] Error processing indexing job for ${r2Key}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    if (error instanceof Error) {
      console.error(
        `[indexing-worker] Error stack: ${error.stack || "no stack"}`
      );
    }
    throw error;
  }
}
