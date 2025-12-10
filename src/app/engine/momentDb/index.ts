import { env } from "cloudflare:workers";
import { MomentGraphDO } from "./durableObject";
import type { Moment, ChunkMetadata } from "../types";
import { type Database, createDb } from "rwsdk/db";
import { type momentMigrations } from "./migrations";
import { getEmbedding } from "../utils/vector";

export { MomentGraphDO };

type MomentDatabase = Database<typeof momentMigrations>;

function getMomentDb() {
  return createDb<MomentDatabase>(
    env.MOMENT_GRAPH_DO as DurableObjectNamespace<MomentGraphDO>,
    "moment-graph"
  );
}

export async function addMoment(moment: Moment): Promise<void> {
  console.log(
    `[momentDb:addMoment] Starting to add moment ${moment.id} (title: "${
      moment.title
    }", document: ${moment.documentId}, parent: ${moment.parentId || "none"})`
  );
  const db = getMomentDb();

  // Generate embedding for the moment summary
  try {
    console.log(
      `[momentDb:addMoment] Generating embedding for moment ${moment.id} (summary length: ${moment.summary.length})`
    );
    const embedding = await getEmbedding(moment.summary);
    // Index the moment in Vectorize
    await env.MOMENT_INDEX.insert([
      {
        id: moment.id,
        values: embedding,
        metadata: {
          chunkId: moment.id, // Using moment ID as chunk ID for consistency
          documentId: moment.documentId,
          source: "moment-graph",
          type: "moment",
          documentTitle: moment.title,
          author: moment.author,
          jsonPath: "$", // Root of the moment
          sourceMetadata: moment.sourceMetadata,
          summary: moment.summary, // Store summary in metadata for quick retrieval if needed (optional)
        } as unknown as ChunkMetadata,
      },
    ]);
    console.log(
      `[momentDb] Indexed moment ${moment.id} in vector index (summary length: ${moment.summary.length})`
    );

    // If this is a root moment (no parent), also index it as a Subject
    if (!moment.parentId) {
      console.log(
        `[momentDb:subject-index] Root moment detected: ${moment.id} (${moment.title}). Indexing as Subject...`
      );
      await env.SUBJECT_INDEX.upsert([
        {
          id: moment.id,
          values: embedding,
          metadata: {
            title: moment.title,
            summary: moment.summary,
            documentId: moment.documentId,
            type: "subject",
          },
        },
      ]);
      console.log(
        `[momentDb:subject-index] Successfully indexed root moment ${moment.id} as Subject in SUBJECT_INDEX (title: "${moment.title}", summary length: ${moment.summary.length})`
      );
    } else {
      console.log(
        `[momentDb:subject-index] Moment ${moment.id} has parent ${moment.parentId}, skipping Subject indexing`
      );
    }
  } catch (error) {
    console.error(
      `[momentDb] Failed to generate/insert embedding for moment ${moment.id}:`,
      error
    );
    // We continue to save to DB even if vector indexing fails
  }

  console.log(
    `[momentDb:addMoment] Checking if moment ${
      moment.id
    } exists in DB (document: ${moment.documentId}, parent: ${
      moment.parentId || "none"
    })`
  );
  const existing = await db
    .selectFrom("moments")
    .where("id", "=", moment.id)
    .selectAll()
    .executeTakeFirst();

  if (existing) {
    console.log(
      `[momentDb:addMoment] Moment ${moment.id} exists, updating in DB...`
    );
    await db
      .updateTable("moments")
      .set({
        document_id: moment.documentId,
        summary: moment.summary,
        title: moment.title,
        parent_id: (moment.parentId ?? null) as any,
        created_at: moment.createdAt,
        author: moment.author,
        source_metadata: (moment.sourceMetadata
          ? JSON.stringify(moment.sourceMetadata)
          : null) as any,
      })
      .where("id", "=", moment.id)
      .execute();
    console.log(`[momentDb:addMoment] Updated moment ${moment.id} in DB`);
  } else {
    console.log(
      `[momentDb:addMoment] Moment ${moment.id} does not exist, inserting into DB...`
    );
    await db
      .insertInto("moments")
      .values({
        id: moment.id,
        document_id: moment.documentId,
        summary: moment.summary,
        title: moment.title,
        parent_id: (moment.parentId ?? null) as any,
        created_at: moment.createdAt,
        author: moment.author,
        source_metadata: (moment.sourceMetadata
          ? JSON.stringify(moment.sourceMetadata)
          : null) as any,
      })
      .execute();
    console.log(`[momentDb:addMoment] Inserted moment ${moment.id} into DB`);
  }
}

export async function getMoment(id: string): Promise<Moment | null> {
  console.log(`[momentDb:getMoment] Querying DB for moment ${id}`);
  const db = getMomentDb();
  const row = await db
    .selectFrom("moments")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();

  if (row) {
    console.log(
      `[momentDb:getMoment] Found moment ${id} in DB (title: "${row.title}")`
    );
  } else {
    console.log(`[momentDb:getMoment] Moment ${id} not found in DB`);
  }

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    documentId: row.document_id,
    summary: row.summary,
    title: row.title,
    parentId: row.parent_id || undefined,
    createdAt: row.created_at,
    author: row.author,
    sourceMetadata: row.source_metadata
      ? typeof row.source_metadata === "string"
        ? (JSON.parse(row.source_metadata) as Record<string, any>)
        : (row.source_metadata as Record<string, any>)
      : undefined,
  };
}

export async function findSimilarMoments(
  vector: number[],
  limit: number = 5
): Promise<Moment[]> {
  const searchResults = await env.MOMENT_INDEX.query(vector, {
    topK: limit,
    returnMetadata: true,
  });

  const moments: Moment[] = [];
  for (const match of searchResults.matches) {
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
  console.log(
    `[momentDb:findDescendants] Starting to find descendants for root moment: ${rootMomentId}`
  );
  const descendants: Moment[] = [];
  const rootMoment = await getMoment(rootMomentId);
  if (!rootMoment) {
    console.log(
      `[momentDb:findDescendants] Root moment ${rootMomentId} not found, returning empty array`
    );
    return descendants;
  }

  // Start with the root moment
  descendants.push(rootMoment);
  console.log(
    `[momentDb:findDescendants] Added root moment: ${rootMoment.id} (${rootMoment.title})`
  );

  // Recursively find all children
  const db = getMomentDb();
  const findChildren = async (
    parentId: string,
    depth: number = 0
  ): Promise<void> => {
    console.log(
      `[momentDb:findDescendants] Querying DB for children of parent ${parentId} at depth ${depth}`
    );
    const children = await db
      .selectFrom("moments")
      .selectAll()
      .where("parent_id", "=", parentId)
      .orderBy("created_at", "asc")
      .execute();

    console.log(
      `[momentDb:findDescendants] Found ${children.length} direct children for parent ${parentId} at depth ${depth}`
    );

    for (const row of children) {
      const childMoment: Moment = {
        id: row.id,
        documentId: row.document_id,
        summary: row.summary,
        title: row.title,
        parentId: row.parent_id || undefined,
        createdAt: row.created_at,
        author: row.author,
        sourceMetadata: row.source_metadata
          ? (JSON.parse(row.source_metadata) as Record<string, any>)
          : undefined,
      };
      descendants.push(childMoment);
      console.log(
        `[momentDb:findDescendants] Added descendant at depth ${depth}: ${childMoment.id} (${childMoment.title})`
      );
      // Recursively find children of this child
      await findChildren(row.id, depth + 1);
    }
  };

  await findChildren(rootMomentId, 0);
  console.log(
    `[momentDb:findDescendants] Completed. Found ${
      descendants.length
    } total moments (1 root + ${descendants.length - 1} descendants)`
  );
  return descendants;
}

export async function findSimilarSubjects(
  vector: number[],
  limit: number = 5
): Promise<Moment[]> {
  console.log(
    `[momentDb:findSimilarSubjects] Querying SUBJECT_INDEX with vector (dimension: ${vector.length}), limit: ${limit}`
  );
  const searchResults = await env.SUBJECT_INDEX.query(vector, {
    topK: limit,
    returnMetadata: true,
  });

  console.log(
    `[momentDb:findSimilarSubjects] SUBJECT_INDEX returned ${searchResults.matches.length} matches`
  );

  const subjects: Moment[] = [];
  for (let i = 0; i < searchResults.matches.length; i++) {
    const match = searchResults.matches[i];
    console.log(
      `[momentDb:findSimilarSubjects] Match ${i + 1}: id=${match.id}, score=${
        match.score
      }, metadata=${JSON.stringify(match.metadata)}`
    );
    const moment = await getMoment(match.id);
    if (moment) {
      subjects.push(moment);
      console.log(
        `[momentDb:findSimilarSubjects] Successfully retrieved Subject moment: ${moment.id} (${moment.title})`
      );
    } else {
      console.warn(
        `[momentDb:findSimilarSubjects] Subject moment ${match.id} not found in database`
      );
    }
  }

  console.log(
    `[momentDb:findSimilarSubjects] Returning ${subjects.length} Subjects`
  );
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
    sourceMetadata: row.source_metadata
      ? typeof row.source_metadata === "string"
        ? (JSON.parse(row.source_metadata) as Record<string, any>)
        : (row.source_metadata as Record<string, any>)
      : undefined,
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

// TEMPORARY: Testing function to clear structure hash cache
export async function clearDocumentStructureHash(): Promise<void> {
  const db = getMomentDb();
  await db.deleteFrom("document_structure_hash").execute();
  console.log("[momentDb] Cleared all document structure hashes (testing)");
}
