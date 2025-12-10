import { env } from "cloudflare:workers";
import { MomentGraphDO } from "./durableObject";
import type { Milestone, ChunkMetadata, MomentDescription } from "../types";
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

export async function addMilestone(milestone: Milestone): Promise<void> {
  console.log(
    `[momentDb:addMilestone] Starting to add milestone ${
      milestone.id
    } (title: "${milestone.title}", document: ${
      milestone.documentId
    }, parent: ${milestone.parentId || "none"})`
  );
  const db = getMomentDb();

  // Generate embedding for the milestone summary
  try {
    console.log(
      `[momentDb:addMilestone] Generating embedding for milestone ${milestone.id} (summary length: ${milestone.summary.length})`
    );
    const embedding = await getEmbedding(milestone.summary);
    // Index the milestone in Vectorize
    await env.MOMENT_INDEX.insert([
      {
        id: milestone.id,
        values: embedding,
        metadata: {
          chunkId: milestone.id, // Using milestone ID as chunk ID for consistency
          documentId: milestone.documentId,
          source: "moment-graph",
          type: "milestone",
          documentTitle: milestone.title,
          author: milestone.author,
          jsonPath: "$", // Root of the milestone
          sourceMetadata: milestone.sourceMetadata,
          summary: milestone.summary, // Store summary in metadata for quick retrieval if needed (optional)
        } as unknown as ChunkMetadata,
      },
    ]);
    console.log(
      `[momentDb] Indexed milestone ${milestone.id} in vector index (summary length: ${milestone.summary.length})`
    );

    // If this is a root milestone (no parent), also index it as a Subject
    if (!milestone.parentId) {
      console.log(
        `[momentDb:subject-index] Root milestone detected: ${milestone.id} (${milestone.title}). Indexing as Subject...`
      );
      await env.SUBJECT_INDEX.upsert([
        {
          id: milestone.id,
          values: embedding,
          metadata: {
            title: milestone.title,
            summary: milestone.summary,
            documentId: milestone.documentId,
            type: "subject",
          },
        },
      ]);
      console.log(
        `[momentDb:subject-index] Successfully indexed root milestone ${milestone.id} as Subject in SUBJECT_INDEX (title: "${milestone.title}", summary length: ${milestone.summary.length})`
      );
    } else {
      console.log(
        `[momentDb:subject-index] Milestone ${milestone.id} has parent ${milestone.parentId}, skipping Subject indexing`
      );
    }
  } catch (error) {
    console.error(
      `[momentDb] Failed to generate/insert embedding for milestone ${milestone.id}:`,
      error
    );
    // We continue to save to DB even if vector indexing fails
  }

  console.log(
    `[momentDb:addMilestone] Checking if milestone ${
      milestone.id
    } exists in DB (document: ${milestone.documentId}, parent: ${
      milestone.parentId || "none"
    })`
  );
  const existing = await db
    .selectFrom("milestones")
    .where("id", "=", milestone.id)
    .selectAll()
    .executeTakeFirst();

  if (existing) {
    console.log(
      `[momentDb:addMilestone] Milestone ${milestone.id} exists, updating in DB...`
    );
    await db
      .updateTable("milestones")
      .set({
        document_id: milestone.documentId,
        summary: milestone.summary,
        title: milestone.title,
        parent_id: (milestone.parentId ?? null) as any,
        created_at: milestone.createdAt,
        author: milestone.author,
        source_metadata: (milestone.sourceMetadata
          ? JSON.stringify(milestone.sourceMetadata)
          : null) as any,
      })
      .where("id", "=", milestone.id)
      .execute();
    console.log(
      `[momentDb:addMilestone] Updated milestone ${milestone.id} in DB`
    );
  } else {
    console.log(
      `[momentDb:addMilestone] Milestone ${milestone.id} does not exist, inserting into DB...`
    );
    await db
      .insertInto("milestones")
      .values({
        id: milestone.id,
        document_id: milestone.documentId,
        summary: milestone.summary,
        title: milestone.title,
        parent_id: (milestone.parentId ?? null) as any,
        created_at: milestone.createdAt,
        author: milestone.author,
        source_metadata: (milestone.sourceMetadata
          ? JSON.stringify(milestone.sourceMetadata)
          : null) as any,
      })
      .execute();
    console.log(
      `[momentDb:addMilestone] Inserted milestone ${milestone.id} into DB`
    );
  }
}

export async function getMilestone(id: string): Promise<Milestone | null> {
  console.log(`[momentDb:getMilestone] Querying DB for milestone ${id}`);
  const db = getMomentDb();
  const row = await db
    .selectFrom("milestones")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();

  if (row) {
    console.log(
      `[momentDb:getMilestone] Found milestone ${id} in DB (title: "${row.title}")`
    );
  } else {
    console.log(`[momentDb:getMilestone] Milestone ${id} not found in DB`);
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

export async function findSimilarMilestones(
  vector: number[],
  limit: number = 5
): Promise<Milestone[]> {
  const searchResults = await env.MOMENT_INDEX.query(vector, {
    topK: limit,
    returnMetadata: true,
  });

  const milestones: Milestone[] = [];
  for (const match of searchResults.matches) {
    const milestone = await getMilestone(match.id);
    if (milestone) {
      milestones.push(milestone);
    }
  }
  return milestones;
}

export async function findAncestors(milestoneId: string): Promise<Milestone[]> {
  const ancestors: Milestone[] = [];
  let currentMilestoneId: string | undefined = milestoneId;

  while (currentMilestoneId) {
    const milestone = await getMilestone(currentMilestoneId);
    if (milestone) {
      ancestors.unshift(milestone);
      currentMilestoneId = milestone.parentId;
    } else {
      currentMilestoneId = undefined;
    }
  }

  return ancestors;
}

export async function findDescendants(
  rootMilestoneId: string
): Promise<Milestone[]> {
  console.log(
    `[momentDb:findDescendants] Starting to find descendants for root milestone: ${rootMilestoneId}`
  );
  const descendants: Milestone[] = [];
  const rootMilestone = await getMilestone(rootMilestoneId);
  if (!rootMilestone) {
    console.log(
      `[momentDb:findDescendants] Root milestone ${rootMilestoneId} not found, returning empty array`
    );
    return descendants;
  }

  // Start with the root milestone
  descendants.push(rootMilestone);
  console.log(
    `[momentDb:findDescendants] Added root milestone: ${rootMilestone.id} (${rootMilestone.title})`
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
      .selectFrom("milestones")
      .selectAll()
      .where("parent_id", "=", parentId)
      .orderBy("created_at", "asc")
      .execute();

    console.log(
      `[momentDb:findDescendants] Found ${children.length} direct children for parent ${parentId} at depth ${depth}`
    );

    for (const row of children) {
      const childMilestone: Milestone = {
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
      descendants.push(childMilestone);
      console.log(
        `[momentDb:findDescendants] Added descendant at depth ${depth}: ${childMilestone.id} (${childMilestone.title})`
      );
      // Recursively find children of this child
      await findChildren(row.id, depth + 1);
    }
  };

  await findChildren(rootMilestoneId, 0);
  console.log(
    `[momentDb:findDescendants] Completed. Found ${
      descendants.length
    } total milestones (1 root + ${descendants.length - 1} descendants)`
  );
  return descendants;
}

export async function findSimilarSubjects(
  vector: number[],
  limit: number = 5
): Promise<Milestone[]> {
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

  const subjects: Milestone[] = [];
  for (let i = 0; i < searchResults.matches.length; i++) {
    const match = searchResults.matches[i];
    console.log(
      `[momentDb:findSimilarSubjects] Match ${i + 1}: id=${match.id}, score=${
        match.score
      }, metadata=${JSON.stringify(match.metadata)}`
    );
    const milestone = await getMilestone(match.id);
    if (milestone) {
      subjects.push(milestone);
      console.log(
        `[momentDb:findSimilarSubjects] Successfully retrieved Subject milestone: ${milestone.id} (${milestone.title})`
      );
    } else {
      console.warn(
        `[momentDb:findSimilarSubjects] Subject milestone ${match.id} not found in database`
      );
    }
  }

  console.log(
    `[momentDb:findSimilarSubjects] Returning ${subjects.length} Subjects`
  );
  return subjects;
}

export async function findLastMilestoneForDocument(
  documentId: string
): Promise<Milestone | null> {
  const db = getMomentDb();
  const rows = await db
    .selectFrom("milestones")
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

export interface Moment {
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

export async function getMoment(
  documentId: string,
  path: string
): Promise<Moment | null> {
  const db = getMomentDb();
  const row = await db
    .selectFrom("moments")
    .selectAll()
    .where("document_id", "=", documentId)
    .where("path", "=", path)
    .executeTakeFirst();

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
    sourceMetadata: row.source_metadata
      ? typeof row.source_metadata === "string"
        ? (JSON.parse(row.source_metadata) as Record<string, any>)
        : (row.source_metadata as Record<string, any>)
      : undefined,
  };
}

export async function upsertMoment(
  moment: MomentDescription,
  documentId: string,
  summary: string,
  embedding: number[]
): Promise<void> {
  const db = getMomentDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db
    .insertInto("moments")
    .values({
      id,
      document_id: documentId,
      path: moment.path,
      content: moment.content,
      summary: summary,
      embedding: JSON.stringify(embedding),
      created_at: moment.createdAt || now,
      author: moment.author,
      source_metadata: moment.sourceMetadata
        ? JSON.stringify(moment.sourceMetadata)
        : null,
    })
    .onConflict((oc) =>
      oc.columns(["document_id", "path"]).doUpdateSet({
        content: moment.content,
        summary: summary,
        embedding: JSON.stringify(embedding),
        author: moment.author,
        source_metadata: moment.sourceMetadata
          ? JSON.stringify(moment.sourceMetadata)
          : null,
      })
    )
    .execute();
}

export async function getMomentsForDocument(
  documentId: string
): Promise<Moment[]> {
  const db = getMomentDb();
  const rows = await db
    .selectFrom("moments")
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
    sourceMetadata: row.source_metadata
      ? typeof row.source_metadata === "string"
        ? (JSON.parse(row.source_metadata) as Record<string, any>)
        : (row.source_metadata as Record<string, any>)
      : undefined,
  }));
}
