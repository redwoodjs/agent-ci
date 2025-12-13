import { env } from "cloudflare:workers";
import { MomentGraphDO } from "./durableObject";
import type { Moment, ChunkMetadata, MicroMomentDescription } from "../types";
import { type Database, createDb } from "rwsdk/db";
import { type momentMigrations } from "./migrations";
import { getEmbedding } from "../utils/vector";
import {
  getMomentGraphNamespaceFromEnv,
  qualifyName,
} from "../momentGraphNamespace";

export { MomentGraphDO };

type MomentDatabase = Database<typeof momentMigrations>;

function getMomentDb() {
  const namespace = getMomentGraphNamespaceFromEnv(env);
  return createDb<MomentDatabase>(
    env.MOMENT_GRAPH_DO as DurableObjectNamespace<MomentGraphDO>,
    qualifyName("moment-graph-v2", namespace)
  );
}

export async function addMoment(moment: Moment): Promise<void> {
  const db = getMomentDb();
  const momentGraphNamespace = getMomentGraphNamespaceFromEnv(env) ?? "default";

  try {
    const embedding = await getEmbedding(moment.summary);
    const momentVector = {
      id: moment.id,
      values: embedding,
      metadata: {
        chunkId: moment.id, // Using moment ID as chunk ID for consistency
        momentGraphNamespace,
        documentId: moment.documentId,
        source: "moment-graph",
        type: "moment",
        documentTitle: moment.title,
        author: moment.author,
        jsonPath: "$", // Root of the moment
        sourceMetadata: moment.sourceMetadata,
        summary: moment.summary, // Store summary in metadata for quick retrieval if needed (optional)
      } as unknown as ChunkMetadata,
    };

    await env.MOMENT_INDEX.upsert([momentVector]);

    await env.SUBJECT_INDEX.upsert([
      {
        id: moment.id,
        values: embedding,
        metadata: {
          momentGraphNamespace,
          title: moment.title,
          summary: moment.summary,
          documentId: moment.documentId,
          type: "subject",
          isSubject: !moment.parentId,
        },
      },
    ]);
  } catch (error) {
    console.error(
      `[momentDb] Failed to generate/insert embedding for moment ${moment.id}:`,
      error
    );
    // We continue to save to DB even if vector indexing fails
  }

  const existing = await db
    .selectFrom("moments")
    .where("id", "=", moment.id)
    .selectAll()
    .executeTakeFirst();

  if (existing) {
    await db
      .updateTable("moments")
      .set({
        document_id: moment.documentId,
        summary: moment.summary,
        title: moment.title,
        parent_id: (moment.parentId ?? null) as any,
        micro_paths_json: moment.microPaths
          ? JSON.stringify(moment.microPaths)
          : (null as any),
        micro_paths_hash: (moment.microPathsHash ?? null) as any,
        created_at: moment.createdAt,
        author: moment.author,
        source_metadata: (moment.sourceMetadata
          ? JSON.stringify(moment.sourceMetadata)
          : null) as any,
      })
      .where("id", "=", moment.id)
      .execute();
  } else {
    await db
      .insertInto("moments")
      .values({
        id: moment.id,
        document_id: moment.documentId,
        summary: moment.summary,
        title: moment.title,
        parent_id: (moment.parentId ?? null) as any,
        micro_paths_json: moment.microPaths
          ? JSON.stringify(moment.microPaths)
          : (null as any),
        micro_paths_hash: (moment.microPathsHash ?? null) as any,
        created_at: moment.createdAt,
        author: moment.author,
        source_metadata: (moment.sourceMetadata
          ? JSON.stringify(moment.sourceMetadata)
          : null) as any,
      })
      .execute();
  }
}

export async function getMoment(id: string): Promise<Moment | null> {
  const db = getMomentDb();
  const row = await db
    .selectFrom("moments")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    documentId: row.document_id,
    summary: row.summary,
    title: row.title,
    parentId: row.parent_id || undefined,
    microPaths:
      (row.micro_paths_json as unknown as string[] | null) || undefined,
    microPathsHash: (row.micro_paths_hash as any) || undefined,
    createdAt: row.created_at,
    author: row.author,
    sourceMetadata:
      (row.source_metadata as unknown as Record<string, any> | null) ||
      undefined,
  };
}

export async function findMomentByMicroPathsHash(
  documentId: string,
  microPathsHash: string
): Promise<Moment | null> {
  const db = getMomentDb();
  const row = await db
    .selectFrom("moments")
    .selectAll()
    .where("document_id", "=", documentId)
    .where("micro_paths_hash", "=", microPathsHash)
    .executeTakeFirst();

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    documentId: row.document_id,
    summary: row.summary,
    title: row.title,
    parentId: row.parent_id || undefined,
    microPaths:
      (row.micro_paths_json as unknown as string[] | null) || undefined,
    microPathsHash: (row.micro_paths_hash as any) || undefined,
    createdAt: row.created_at,
    author: row.author,
    sourceMetadata:
      (row.source_metadata as unknown as Record<string, any> | null) ||
      undefined,
  };
}

export async function findSimilarMoments(
  vector: number[],
  limit: number = 5
): Promise<Moment[]> {
  const momentGraphNamespace = getMomentGraphNamespaceFromEnv(env) ?? "default";
  const searchResults = await env.MOMENT_INDEX.query(vector, {
    topK: limit,
    returnMetadata: true,
  });

  const moments: Moment[] = [];
  for (const match of searchResults.matches) {
    const matchNamespace =
      (match.metadata as any)?.momentGraphNamespace ?? null;
    const normalizedMatchNamespace = matchNamespace ?? "default";
    if (normalizedMatchNamespace !== momentGraphNamespace) {
      continue;
    }
    const moment = await getMoment(match.id);
    if (moment) {
      moments.push(moment);
    }
  }
  return moments;
}

export async function findAncestors(momentId: string): Promise<Moment[]> {
  const ancestors: Moment[] = [];
  let currentMomentId: string | undefined = momentId;

  while (currentMomentId) {
    const moment = await getMoment(currentMomentId);
    if (moment) {
      ancestors.unshift(moment);
      currentMomentId = moment.parentId;
    } else {
      currentMomentId = undefined;
    }
  }

  return ancestors;
}

export async function findDescendants(rootMomentId: string): Promise<Moment[]> {
  const descendants: Moment[] = [];
  const rootMoment = await getMoment(rootMomentId);
  if (!rootMoment) {
    return descendants;
  }

  // Start with the root moment
  descendants.push(rootMoment);

  // Recursively find all children
  const db = getMomentDb();
  const findChildren = async (
    parentId: string,
    depth: number = 0
  ): Promise<void> => {
    const children = await db
      .selectFrom("moments")
      .selectAll()
      .where("parent_id", "=", parentId)
      .orderBy("created_at", "asc")
      .execute();

    for (const row of children) {
      const childMoment: Moment = {
        id: row.id,
        documentId: row.document_id,
        summary: row.summary,
        title: row.title,
        parentId: row.parent_id || undefined,
        microPaths: row.micro_paths_json
          ? (JSON.parse(row.micro_paths_json as any) as string[])
          : undefined,
        microPathsHash: (row.micro_paths_hash as any) || undefined,
        createdAt: row.created_at,
        author: row.author,
        sourceMetadata: row.source_metadata
          ? typeof row.source_metadata === "string"
            ? (JSON.parse(row.source_metadata) as Record<string, any>)
            : (row.source_metadata as Record<string, any>)
          : undefined,
      };
      descendants.push(childMoment);
      // Recursively find children of this child
      await findChildren(row.id, depth + 1);
    }
  };

  await findChildren(rootMomentId, 0);
  return descendants;
}

export async function findSimilarSubjects(
  vector: number[],
  limit: number = 5
): Promise<Moment[]> {
  const momentGraphNamespace = getMomentGraphNamespaceFromEnv(env) ?? "default";
  const searchResults = await env.SUBJECT_INDEX.query(vector, {
    topK: limit,
    returnMetadata: true,
  });

  const subjects: Moment[] = [];
  for (let i = 0; i < searchResults.matches.length; i++) {
    const match = searchResults.matches[i];
    const matchNamespace =
      (match.metadata as any)?.momentGraphNamespace ?? null;
    const normalizedMatchNamespace = matchNamespace ?? "default";
    if (normalizedMatchNamespace !== momentGraphNamespace) {
      continue;
    }
    const moment = await getMoment(match.id);
    if (moment && !moment.parentId) {
      subjects.push(moment);
    } else {
      console.warn(
        `[momentDb:findSimilarSubjects] Subject moment ${match.id} not found in database`
      );
    }
  }

  return subjects;
}

export async function findLastMomentForDocument(
  documentId: string
): Promise<Moment | null> {
  const db = getMomentDb();
  const rows = await db
    .selectFrom("moments")
    .selectAll()
    .where("document_id", "=", documentId)
    .orderBy("created_at", "desc")
    .limit(1)
    .execute();

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];
  return {
    id: row.id,
    documentId: row.document_id,
    summary: row.summary,
    title: row.title,
    parentId: row.parent_id || undefined,
    createdAt: row.created_at,
    author: row.author,
    sourceMetadata:
      (row.source_metadata as unknown as Record<string, any> | null) ||
      undefined,
  };
}

export async function getDocumentStructureHash(
  documentId: string
): Promise<string | null> {
  const db = getMomentDb();
  const row = await db
    .selectFrom("document_structure_hash")
    .selectAll()
    .where("document_id", "=", documentId)
    .executeTakeFirst();

  return row?.structure_hash || null;
}

export async function setDocumentStructureHash(
  documentId: string,
  hash: string
): Promise<void> {
  const db = getMomentDb();
  const now = new Date().toISOString();

  await db
    .insertInto("document_structure_hash")
    .values({
      document_id: documentId,
      structure_hash: hash,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.column("document_id").doUpdateSet({
        structure_hash: hash,
        updated_at: now,
      })
    )
    .execute();
}

export interface MicroMoment {
  id: string;
  documentId: string;
  path: string;
  content: string;
  summary: string | null;
  embedding: number[] | null;
  createdAt: string;
  author: string;
  sourceMetadata?: Record<string, any>;
}

export async function getMicroMoment(
  documentId: string,
  path: string
): Promise<MicroMoment | null> {
  const start = Date.now();
  const db = getMomentDb();
  const row = await db
    .selectFrom("micro_moments")
    .selectAll()
    .where("document_id", "=", documentId)
    .where("path", "=", path)
    .executeTakeFirst();
  const duration = Date.now() - start;
  if (duration > 10) {
    // Keep this one log if latency is high, otherwise silent
    // console.log(`[momentDb] getMicroMoment slow query: ${duration}ms`);
  }

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    documentId: row.document_id,
    path: row.path,
    content: row.content,
    summary: row.summary || null,
    embedding: row.embedding
      ? typeof row.embedding === "string"
        ? (JSON.parse(row.embedding) as number[])
        : (row.embedding as number[])
      : null,
    createdAt: row.created_at,
    author: row.author,
    sourceMetadata:
      (row.source_metadata as unknown as Record<string, any> | null) ||
      undefined,
  };
}

export async function upsertMicroMoment(
  microMoment: MicroMomentDescription,
  documentId: string,
  summary: string,
  embedding: number[]
): Promise<void> {
  const db = getMomentDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db
    .insertInto("micro_moments")
    .values({
      id,
      document_id: documentId,
      path: microMoment.path,
      content: microMoment.content,
      summary: summary,
      embedding: JSON.stringify(embedding),
      created_at: microMoment.createdAt || now,
      author: microMoment.author,
      source_metadata: microMoment.sourceMetadata
        ? JSON.stringify(microMoment.sourceMetadata)
        : (null as any),
    })
    .onConflict((oc) =>
      oc.columns(["document_id", "path"]).doUpdateSet({
        content: microMoment.content,
        summary: summary,
        embedding: JSON.stringify(embedding),
        author: microMoment.author,
        source_metadata: microMoment.sourceMetadata
          ? JSON.stringify(microMoment.sourceMetadata)
          : undefined,
      })
    )
    .execute();
}

export async function getMicroMomentsForDocument(
  documentId: string
): Promise<MicroMoment[]> {
  const db = getMomentDb();
  const rows = await db
    .selectFrom("micro_moments")
    .selectAll()
    .where("document_id", "=", documentId)
    .orderBy("created_at", "asc")
    .execute();

  return rows.map((row) => ({
    id: row.id,
    documentId: row.document_id,
    path: row.path,
    content: row.content,
    summary: row.summary || null,
    embedding: row.embedding
      ? typeof row.embedding === "string"
        ? (JSON.parse(row.embedding) as number[])
        : (row.embedding as number[])
      : null,
    createdAt: row.created_at,
    author: row.author,
    sourceMetadata:
      (row.source_metadata as unknown as Record<string, any> | null) ||
      undefined,
  }));
}
