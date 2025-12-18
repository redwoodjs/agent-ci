import { MomentGraphDO } from "./durableObject";
import type { Moment, ChunkMetadata, MicroMomentDescription } from "../types";
import { type Database, createDb } from "rwsdk/db";
import { type momentMigrations } from "./migrations";
import { getEmbedding } from "../utils/vector";
import { Override } from "@/app/shared/kyselyTypeOverrides";
import { qualifyName } from "../momentGraphNamespace";

export { MomentGraphDO };

type MomentDatabase = Database<typeof momentMigrations>;
type MomentInput = MomentDatabase["moments"];
type MomentRow = Override<
  MomentInput,
  {
    micro_paths_json: string[] | null;
    source_metadata: Record<string, any> | null;
  }
>;

type MicroMomentBatchInput = MomentDatabase["micro_moment_batches"];
type MicroMomentBatchRow = Override<
  MicroMomentBatchInput,
  {
    items_json: MicroMoment[];
  }
>;

export type MomentGraphContext = {
  env: Cloudflare.Env;
  momentGraphNamespace: string | null;
};

function getMomentDb(context: MomentGraphContext) {
  return createDb<MomentDatabase>(
    context.env.MOMENT_GRAPH_DO as DurableObjectNamespace<MomentGraphDO>,
    qualifyName("moment-graph-v2", context.momentGraphNamespace)
  );
}

export async function addMoment(
  moment: Moment,
  context: MomentGraphContext
): Promise<void> {
  const db = getMomentDb(context);
  const momentGraphNamespace = context.momentGraphNamespace ?? "default";

  function serializeSourceMetadata(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function readTimeRange(
    value: unknown
  ): { start: string; end: string } | null {
    const range = (value as any)?.timeRange;
    const start = typeof range?.start === "string" ? range.start : null;
    const end = typeof range?.end === "string" ? range.end : null;
    if (!start || !end) {
      return null;
    }
    return { start, end };
  }

  try {
    const embedding = await getEmbedding(moment.summary);
    const timeRange = readTimeRange(moment.sourceMetadata);
    const sourceMetadataJson = serializeSourceMetadata(moment.sourceMetadata);
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
        sourceMetadataJson,
        ...(timeRange ? { timeRangeStart: timeRange.start } : null),
        ...(timeRange ? { timeRangeEnd: timeRange.end } : null),
        summary: moment.summary, // Store summary in metadata for quick retrieval if needed (optional)
        ...(typeof moment.importance === "number"
          ? { importance: moment.importance }
          : null),
      } as unknown as ChunkMetadata,
    };

    console.log("[moment-linker] vector upsert (moment)", {
      id: moment.id,
      momentGraphNamespace,
      documentId: moment.documentId,
      type: "moment",
    });
    await context.env.MOMENT_INDEX.upsert([momentVector]);

    console.log("[moment-linker] vector upsert (subject)", {
      id: moment.id,
      momentGraphNamespace,
      documentId: moment.documentId,
      type: "subject",
      isSubject: !moment.parentId,
    });
    await context.env.SUBJECT_INDEX.upsert([
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
        importance:
          typeof moment.importance === "number"
            ? moment.importance
            : (null as any),
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
        importance:
          typeof moment.importance === "number"
            ? moment.importance
            : (null as any),
        created_at: moment.createdAt,
        author: moment.author,
        source_metadata: (moment.sourceMetadata
          ? JSON.stringify(moment.sourceMetadata)
          : null) as any,
      })
      .execute();
  }
}

export async function getMoment(
  id: string,
  context: MomentGraphContext
): Promise<Moment | null> {
  const db = getMomentDb(context);
  const row = (await db
    .selectFrom("moments")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst()) as MomentRow | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    documentId: row.document_id,
    summary: row.summary,
    title: row.title,
    parentId: row.parent_id || undefined,
    microPaths: row.micro_paths_json || undefined,
    microPathsHash: row.micro_paths_hash || undefined,
    importance: typeof row.importance === "number" ? row.importance : undefined,
    createdAt: row.created_at,
    author: row.author,
    sourceMetadata: row.source_metadata || undefined,
  };
}

export async function getMoments(
  ids: string[],
  context: MomentGraphContext
): Promise<Map<string, Moment>> {
  if (ids.length === 0) {
    return new Map();
  }

  const db = getMomentDb(context);
  const moments = new Map<string, Moment>();

  const maxBatchSize = 100;
  for (let i = 0; i < ids.length; i += maxBatchSize) {
    const batch = ids.slice(i, i + maxBatchSize);
    const rows = (await db
      .selectFrom("moments")
      .selectAll()
      .where("id", "in", batch)
      .execute()) as unknown as MomentRow[];

    for (const row of rows) {
      moments.set(row.id, {
        id: row.id,
        documentId: row.document_id,
        summary: row.summary,
        title: row.title,
        parentId: row.parent_id || undefined,
        microPaths: row.micro_paths_json || undefined,
        microPathsHash: row.micro_paths_hash || undefined,
        importance:
          typeof row.importance === "number" ? row.importance : undefined,
        createdAt: row.created_at,
        author: row.author,
        sourceMetadata: row.source_metadata || undefined,
      });
    }
  }

  return moments;
}

export async function findMomentByMicroPathsHash(
  documentId: string,
  microPathsHash: string,
  context: MomentGraphContext
): Promise<Moment | null> {
  const db = getMomentDb(context);
  const row = (await db
    .selectFrom("moments")
    .selectAll()
    .where("document_id", "=", documentId)
    .where("micro_paths_hash", "=", microPathsHash)
    .executeTakeFirst()) as MomentRow | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    documentId: row.document_id,
    summary: row.summary,
    title: row.title,
    parentId: row.parent_id || undefined,
    microPaths: row.micro_paths_json || undefined,
    microPathsHash: row.micro_paths_hash || undefined,
    importance: typeof row.importance === "number" ? row.importance : undefined,
    createdAt: row.created_at,
    author: row.author,
    sourceMetadata: row.source_metadata || undefined,
  };
}

export async function findSimilarMoments(
  vector: number[],
  limit: number = 5,
  context: MomentGraphContext
): Promise<Moment[]> {
  const momentGraphNamespace = context.momentGraphNamespace ?? "default";
  const queryOptions: Record<string, unknown> = {
    topK: limit,
    returnMetadata: true,
  };
  if (momentGraphNamespace !== "default") {
    queryOptions.filter = { momentGraphNamespace };
  }
  const searchResults = await context.env.MOMENT_INDEX.query(
    vector,
    queryOptions as any
  );

  const candidatesToLog = 10;

  const matchIdsAll = Array.from(
    new Set(
      searchResults.matches
        .slice(0, candidatesToLog)
        .map((m: any) => m?.id)
        .filter((id: unknown): id is string => typeof id === "string")
    )
  );
  const momentsMapAll =
    matchIdsAll.length > 0 ? await getMoments(matchIdsAll, context) : null;

  const momentIds: string[] = [];
  for (const match of searchResults.matches) {
    const matchNamespace =
      (match.metadata as any)?.momentGraphNamespace ?? null;
    const normalizedMatchNamespace = matchNamespace ?? "default";
    if (normalizedMatchNamespace !== momentGraphNamespace) {
      continue;
    }
    momentIds.push(match.id);
  }

  const candidates = searchResults.matches
    .slice(0, candidatesToLog)
    .map((match: any) => {
      const id = typeof match?.id === "string" ? match.id : null;
      const matchNamespace =
        (match?.metadata as any)?.momentGraphNamespace ?? null;
      const normalizedMatchNamespace = matchNamespace ?? "default";
      const moment = id && momentsMapAll ? momentsMapAll.get(id) : undefined;
      return {
        id,
        score: typeof match?.score === "number" ? match.score : null,
        matchNamespace: normalizedMatchNamespace,
        inNamespace: normalizedMatchNamespace === momentGraphNamespace,
        inDb: Boolean(moment),
        parentId: moment?.parentId ?? null,
        documentId: moment?.documentId ?? null,
      };
    });
  console.log("[momentDb:findSimilarMoments] candidates", {
    momentGraphNamespace,
    candidates,
  });

  if (momentIds.length === 0) {
    return [];
  }

  const momentsMap = momentsMapAll ?? (await getMoments(momentIds, context));
  return momentIds
    .map((id) => momentsMap.get(id))
    .filter((m): m is Moment => m !== undefined);
}

export async function findAncestors(
  momentId: string,
  context: MomentGraphContext
): Promise<Moment[]> {
  const db = getMomentDb(context);
  const idRows = await db
    .selectFrom("moments")
    .select(["id", "parent_id"])
    .execute();

  const parentById = new Map<string, string | undefined>();
  for (const row of idRows) {
    parentById.set(row.id, row.parent_id || undefined);
  }

  const ancestorIds: string[] = [];
  const visited = new Set<string>();
  const maxDepth = 5_000;
  let currentMomentId: string | undefined = momentId;

  for (let depth = 0; depth < maxDepth && currentMomentId; depth++) {
    if (visited.has(currentMomentId)) {
      break;
    }
    visited.add(currentMomentId);
    ancestorIds.push(currentMomentId);
    currentMomentId = parentById.get(currentMomentId);
  }

  if (ancestorIds.length === 0) {
    return [];
  }

  const momentsMap = await getMoments(ancestorIds, context);
  const ancestors: Moment[] = [];
  for (let i = ancestorIds.length - 1; i >= 0; i--) {
    const id = ancestorIds[i];
    const moment = momentsMap.get(id);
    if (moment) {
      ancestors.push(moment);
    }
  }

  return ancestors;
}

export async function findDescendants(
  rootMomentId: string,
  context: MomentGraphContext
): Promise<Moment[]> {
  const db = getMomentDb(context);
  const rows = (await db
    .selectFrom("moments")
    .selectAll()
    .execute()) as unknown as MomentRow[];

  const rowsById = new Map<string, MomentRow>();
  const childrenByParentId = new Map<string, MomentRow[]>();

  for (const row of rows) {
    rowsById.set(row.id, row);
    const parentId = row.parent_id || undefined;
    if (!parentId) {
      continue;
    }
    const list = childrenByParentId.get(parentId) ?? [];
    list.push(row);
    childrenByParentId.set(parentId, list);
  }

  for (const [parentId, list] of childrenByParentId.entries()) {
    list.sort((a, b) => {
      if (a.created_at !== b.created_at) {
        return a.created_at.localeCompare(b.created_at);
      }
      return a.id.localeCompare(b.id);
    });
    childrenByParentId.set(parentId, list);
  }

  const rootRow = rowsById.get(rootMomentId);
  if (!rootRow) {
    return [];
  }

  function rowToMoment(row: MomentRow): Moment {
    return {
      id: row.id,
      documentId: row.document_id,
      summary: row.summary,
      title: row.title,
      parentId: row.parent_id || undefined,
      microPaths: row.micro_paths_json || undefined,
      microPathsHash: row.micro_paths_hash || undefined,
      importance:
        typeof row.importance === "number" ? row.importance : undefined,
      createdAt: row.created_at,
      author: row.author,
      sourceMetadata: row.source_metadata || undefined,
    };
  }

  const out: Moment[] = [];
  const visited = new Set<string>();
  const maxNodes = 50_000;

  function visit(id: string) {
    if (out.length >= maxNodes) {
      return;
    }
    if (visited.has(id)) {
      return;
    }
    visited.add(id);
    const row = rowsById.get(id);
    if (!row) {
      return;
    }
    out.push(rowToMoment(row));
    const children = childrenByParentId.get(id) ?? [];
    for (const child of children) {
      visit(child.id);
    }
  }

  visit(rootMomentId);

  out.sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt.localeCompare(b.createdAt);
    }
    return a.id.localeCompare(b.id);
  });

  return out;
}

export async function findSimilarSubjects(
  vector: number[],
  limit: number = 5,
  context: MomentGraphContext
): Promise<Moment[]> {
  const momentGraphNamespace = context.momentGraphNamespace ?? "default";
  const queryOptions: Record<string, unknown> = {
    topK: limit,
    returnMetadata: true,
  };
  if (momentGraphNamespace !== "default") {
    queryOptions.filter = { momentGraphNamespace };
  }
  const searchResults = await context.env.SUBJECT_INDEX.query(
    vector,
    queryOptions as any
  );

  const matchIdsAll = Array.from(
    new Set(
      searchResults.matches
        .map((m: any) => m?.id)
        .filter((id: unknown): id is string => typeof id === "string")
    )
  );

  const subjectIds: string[] = [];
  for (let i = 0; i < searchResults.matches.length; i++) {
    const match = searchResults.matches[i];
    const matchNamespace =
      (match.metadata as any)?.momentGraphNamespace ?? null;
    const normalizedMatchNamespace = matchNamespace ?? "default";
    if (normalizedMatchNamespace !== momentGraphNamespace) {
      continue;
    }
    subjectIds.push(match.id);
  }

  const momentsMapAll =
    matchIdsAll.length > 0 ? await getMoments(matchIdsAll, context) : null;
  const candidates = searchResults.matches.map((match: any) => {
    const id = typeof match?.id === "string" ? match.id : null;
    const matchNamespace =
      (match?.metadata as any)?.momentGraphNamespace ?? null;
    const normalizedMatchNamespace = matchNamespace ?? "default";
    const moment = id && momentsMapAll ? momentsMapAll.get(id) : undefined;
    return {
      id,
      score: typeof match?.score === "number" ? match.score : null,
      matchNamespace: normalizedMatchNamespace,
      inNamespace: normalizedMatchNamespace === momentGraphNamespace,
      inDb: Boolean(moment),
      isRoot: moment ? !moment.parentId : null,
      parentId: moment?.parentId ?? null,
      documentId: moment?.documentId ?? null,
    };
  });
  console.log("[momentDb:findSimilarSubjects] candidates", {
    momentGraphNamespace,
    candidates,
  });

  if (subjectIds.length === 0) {
    return [];
  }

  const momentsMap = momentsMapAll ?? (await getMoments(subjectIds, context));
  const subjects: Moment[] = [];
  for (const id of subjectIds) {
    const moment = momentsMap.get(id);
    if (moment && !moment.parentId) {
      subjects.push(moment);
    } else if (!moment) {
      console.warn(
        `[momentDb:findSimilarSubjects] Subject moment ${id} not found in database`
      );
    }
  }

  return subjects;
}

export async function findLastMomentForDocument(
  documentId: string,
  context: MomentGraphContext
): Promise<Moment | null> {
  const db = getMomentDb(context);
  const rows = (await db
    .selectFrom("moments")
    .selectAll()
    .where("document_id", "=", documentId)
    .orderBy("created_at", "desc")
    .limit(1)
    .execute()) as unknown as MomentRow[];

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
    sourceMetadata: row.source_metadata || undefined,
  };
}

export async function getDocumentStructureHash(
  documentId: string,
  context: MomentGraphContext
): Promise<string | null> {
  const db = getMomentDb(context);
  const row = await db
    .selectFrom("document_structure_hash")
    .selectAll()
    .where("document_id", "=", documentId)
    .executeTakeFirst();

  return row?.structure_hash || null;
}

export async function setDocumentStructureHash(
  documentId: string,
  hash: string,
  context: MomentGraphContext
): Promise<void> {
  const db = getMomentDb(context);
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
  path: string,
  context: MomentGraphContext
): Promise<MicroMoment | null> {
  const db = getMomentDb(context);
  const rows = (await db
    .selectFrom("micro_moment_batches")
    .select(["items_json"])
    .where("document_id", "=", documentId)
    .execute()) as unknown as Pick<MicroMomentBatchRow, "items_json">[];

  for (const row of rows) {
    const match = row.items_json.find((m) => m.path === path);
    if (match) {
      return match;
    }
  }

  return null;
}

export async function upsertMicroMoment(
  microMoment: MicroMomentDescription,
  documentId: string,
  summary: string,
  embedding: number[],
  context: MomentGraphContext
): Promise<void> {
  await upsertMicroMomentsBatch(
    documentId,
    [
      {
        path: microMoment.path,
        content: microMoment.content,
        summary,
        embedding,
        createdAt: microMoment.createdAt,
        author: microMoment.author,
        sourceMetadata: microMoment.sourceMetadata,
      },
    ],
    context
  );
}

export async function upsertMicroMomentsBatch(
  documentId: string,
  items: Array<{
    path: string;
    content: string;
    summary: string;
    embedding: number[];
    createdAt?: string;
    author: string;
    sourceMetadata?: Record<string, any>;
  }>,
  context: MomentGraphContext
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const db = getMomentDb(context);
  const now = new Date().toISOString();

  const batchHashRaw = items[0]?.sourceMetadata?.chunkBatchHash;
  const batchHash = typeof batchHashRaw === "string" ? batchHashRaw : null;
  if (!batchHash) {
    throw new Error(
      "Micro-moment batch upsert requires sourceMetadata.chunkBatchHash"
    );
  }

  const itemsJson = JSON.stringify(
    items.map((item) => ({
      id: crypto.randomUUID(),
      documentId,
      path: item.path,
      content: item.content,
      summary: item.summary,
      embedding: item.embedding,
      createdAt: item.createdAt || now,
      author: item.author,
      sourceMetadata: item.sourceMetadata,
    }))
  );

  await db
    .insertInto("micro_moment_batches")
    .values({
      document_id: documentId,
      batch_hash: batchHash,
      items_json: itemsJson,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.columns(["document_id", "batch_hash"]).doUpdateSet({
        items_json: itemsJson,
        updated_at: now,
      })
    )
    .execute();
}

export async function getMicroMomentsForDocument(
  documentId: string,
  context: MomentGraphContext
): Promise<MicroMoment[]> {
  const db = getMomentDb(context);
  const rows = (await db
    .selectFrom("micro_moment_batches")
    .select(["items_json"])
    .where("document_id", "=", documentId)
    .execute()) as unknown as Pick<MicroMomentBatchRow, "items_json">[];

  const out: MicroMoment[] = [];
  for (const row of rows) {
    out.push(...row.items_json);
  }

  out.sort((a, b) => {
    const aMs = Date.parse(a.createdAt);
    const bMs = Date.parse(b.createdAt);
    if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) {
      return aMs - bMs;
    }
    return a.path.localeCompare(b.path);
  });

  return out;
}
