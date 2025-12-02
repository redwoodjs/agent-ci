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
    console.log(
      `[chunk-processor] Starting job for chunk: ${chunk.id} from doc: ${chunk.documentId}`
    );

    // 1. Update the Knowledge Graph (SubjectDO)
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
        console.log(`[chunk-processor] Updated narrative for subject ${subject.id}`);
      } else {
        // This case should ideally not be hit if the scheduler created the subject,
        // but as a fallback, we log a warning.
        console.warn(
          `[chunk-processor] Subject ${chunk.metadata.subjectId} not found for chunk ${chunk.id}. Cannot update narrative.`
        );
      }
    }

    // 2. Update the Evidence Locker (Vectorize)
    const embedding = await generateEmbedding(chunk.content, env);
    const vectorId = await hashChunkId(chunk.metadata.chunkId);

    const vector = {
      id: vectorId,
      values: embedding,
      metadata: chunk.metadata,
    };

    await env.VECTORIZE_INDEX.insert([vector]);
    console.log(
      `[chunk-processor] Successfully inserted vector ${vectorId} for chunk ${chunk.id} into Vectorize.`
    );
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
