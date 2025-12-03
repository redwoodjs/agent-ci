import { createEngineContext, indexDocument } from "../index";
import { Chunk } from "../types";
import { getSubject, putSubject } from "../subjectDb";
import { createDb, type Database } from "rwsdk/db";
import type { SubjectDO } from "../subjectDb/durableObject";
import { type subjectMigrations } from "../subjectDb/migrations";

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
    if (chunk.metadata.subjectId) {
      type SubjectDatabase = Database<typeof subjectMigrations>;
      const subjectDb = createDb<SubjectDatabase>(
        env.SUBJECT_GRAPH_DO as DurableObjectNamespace<SubjectDO>,
        "subject-graph"
      );

      const subject = await getSubject(subjectDb, chunk.metadata.subjectId);
      if (subject) {
        const updatedNarrative = `${subject.narrative || ""}\\n\\n---\\n\\n${
          chunk.content
        }`;
        subject.narrative = updatedNarrative;
        await putSubject(subjectDb, subject);
      }
    }

    const embedding = await generateEmbedding(chunk.content, env);
    const vectorId = await hashChunkId(chunk.metadata.chunkId);

    await env.VECTORIZE_INDEX.insert([
      {
        id: vectorId,
        values: embedding,
        metadata: chunk.metadata,
      },
    ]);
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
