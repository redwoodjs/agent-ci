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
    link_audit_log: Record<string, any> | null;
  }
>;

type MicroMomentBatchInput = MomentDatabase["micro_moment_batches"];
type MicroMomentBatchRow = Override<
  MicroMomentBatchInput,
  {
    items_json: MicroMoment[];
  }
>;

type DocumentAuditInput = MomentDatabase["document_audit_logs"];
type DocumentAuditRow = Override<
  DocumentAuditInput,
  {
    payload_json: Record<string, any>;
  }
>;

export type MomentGraphContext = {
  env: Cloudflare.Env;
  momentGraphNamespace: string | null;
};

const MIN_VECTOR_IMPORTANCE_FOR_VECTORIZE = 0.4;

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
  const safeParentId =
    typeof moment.parentId === "string" && moment.parentId.length > 0
      ? moment.parentId
      : null;

  async function wouldCreateCycle(
    childId: string,
    parentId: string
  ): Promise<boolean> {
    const visited = new Set<string>();
    const maxDepth = 5_000;
    let current: string | null = parentId;
    for (let depth = 0; depth < maxDepth && current; depth++) {
      if (current === childId) {
        return true;
      }
      if (visited.has(current)) {
        return false;
      }
      visited.add(current);
      const row = (await db
        .selectFrom("moments")
        .select(["parent_id"])
        .where("id", "=", current)
        .executeTakeFirst()) as { parent_id: string | null } | undefined;
      const pid: string | null =
        typeof row?.parent_id === "string" ? row.parent_id : null;
      current = pid;
    }
    return false;
  }

  let parentIdToWrite = safeParentId;
  if (parentIdToWrite) {
    const cycle = await wouldCreateCycle(moment.id, parentIdToWrite);
    if (cycle) {
      console.log("[moment-linker] cycle-prevention rejected attachment", {
        momentId: moment.id,
        documentId: moment.documentId,
        attemptedParentId: parentIdToWrite,
        momentGraphNamespace,
      });
      parentIdToWrite = null;
    }
  }

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

  const linkAuditLogJson = serializeSourceMetadata(moment.linkAuditLog);

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

  const shouldVectorize =
    typeof moment.importance === "number" &&
    Number.isFinite(moment.importance) &&
    moment.importance < MIN_VECTOR_IMPORTANCE_FOR_VECTORIZE
      ? false
      : true;

  try {
    if (shouldVectorize) {
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
        isSubject: !parentIdToWrite,
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
            isSubject: !parentIdToWrite,
          },
        },
      ]);
    } else {
      console.log("[moment-linker] vector upsert skipped (low importance)", {
        id: moment.id,
        momentGraphNamespace,
        documentId: moment.documentId,
        importance: moment.importance ?? null,
        cutoff: MIN_VECTOR_IMPORTANCE_FOR_VECTORIZE,
      });
      try {
        const momentIndexAny = context.env.MOMENT_INDEX as any;
        if (typeof momentIndexAny?.deleteByIds === "function") {
          await momentIndexAny.deleteByIds([moment.id]);
        }
        const subjectIndexAny = context.env.SUBJECT_INDEX as any;
        if (typeof subjectIndexAny?.deleteByIds === "function") {
          await subjectIndexAny.deleteByIds([moment.id]);
        }
      } catch (error) {
        console.error("[moment-linker] vector delete failed (low importance)", {
          id: moment.id,
          momentGraphNamespace,
          documentId: moment.documentId,
          error: String(error),
        });
      }
    }
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
        parent_id: (parentIdToWrite ?? null) as any,
        micro_paths_json: moment.microPaths
          ? JSON.stringify(moment.microPaths)
          : (null as any),
        micro_paths_hash: (moment.microPathsHash ?? null) as any,
        importance:
          typeof moment.importance === "number"
            ? moment.importance
            : (null as any),
        link_audit_log: (linkAuditLogJson ?? null) as any,
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
        parent_id: (parentIdToWrite ?? null) as any,
        micro_paths_json: moment.microPaths
          ? JSON.stringify(moment.microPaths)
          : (null as any),
        micro_paths_hash: (moment.microPathsHash ?? null) as any,
        importance:
          typeof moment.importance === "number"
            ? moment.importance
            : (null as any),
        link_audit_log: (linkAuditLogJson ?? null) as any,
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
    linkAuditLog: row.link_audit_log || undefined,
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
        linkAuditLog: row.link_audit_log || undefined,
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
    linkAuditLog: row.link_audit_log || undefined,
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
      linkAuditLog: row.link_audit_log || undefined,
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

export type DescendantNode = {
  id: string;
  documentId: string;
  title: string;
  parentId?: string;
  createdAt: string;
  importance?: number;
};

export async function findDescendantsSlim(
  rootMomentId: string,
  context: MomentGraphContext,
  options?: { maxNodes?: number }
): Promise<{ nodes: DescendantNode[]; truncated: boolean }> {
  const db = getMomentDb(context);
  const rows = (await db
    .selectFrom("moments")
    .select([
      "id",
      "document_id",
      "title",
      "parent_id",
      "created_at",
      "importance",
    ])
    .execute()) as Array<{
    id: string;
    document_id: string;
    title: string;
    parent_id: string | null;
    created_at: string;
    importance: number | null;
  }>;

  const rowsById = new Map<string, (typeof rows)[number]>();
  const childrenByParentId = new Map<string, Array<(typeof rows)[number]>>();

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
    return { nodes: [], truncated: false };
  }

  function rowToNode(row: (typeof rows)[number]): DescendantNode {
    return {
      id: row.id,
      documentId: row.document_id,
      title: row.title || `Moment ${row.id.substring(0, 8)}`,
      parentId: row.parent_id || undefined,
      createdAt: row.created_at,
      importance:
        typeof row.importance === "number" ? row.importance : undefined,
    };
  }

  const maxNodesRaw = options?.maxNodes;
  const maxNodes =
    typeof maxNodesRaw === "number" &&
    Number.isFinite(maxNodesRaw) &&
    maxNodesRaw > 0
      ? Math.floor(maxNodesRaw)
      : 5000;

  const out: DescendantNode[] = [];
  const visited = new Set<string>();
  let truncated = false;

  function visit(id: string) {
    if (out.length >= maxNodes) {
      truncated = true;
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
    out.push(rowToNode(row));
    const children = childrenByParentId.get(id) ?? [];
    for (const child of children) {
      visit(child.id);
      if (truncated) {
        return;
      }
    }
  }

  visit(rootMomentId);

  out.sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt.localeCompare(b.createdAt);
    }
    return a.id.localeCompare(b.id);
  });

  return { nodes: out, truncated };
}

export async function findMomentsBySearch(
  searchText: string,
  context: MomentGraphContext,
  limit: number = 20
): Promise<Moment[]> {
  const db = getMomentDb(context);
  const trimmed = typeof searchText === "string" ? searchText.trim() : "";
  if (trimmed.length === 0) {
    return [];
  }

  const safeLimit =
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
  const pattern = `%${trimmed}%`;

  const rows = (await db
    .selectFrom("moments")
    .select([
      "id",
      "document_id",
      "summary",
      "title",
      "parent_id",
      "micro_paths_json",
      "micro_paths_hash",
      "importance",
      "link_audit_log",
      "created_at",
      "author",
      "source_metadata",
    ])
    .where((eb) =>
      eb.or([
        eb("title", "like", pattern),
        eb("summary", "like", pattern),
        eb("document_id", "like", pattern),
      ])
    )
    .limit(safeLimit)
    .execute()) as unknown as MomentRow[];

  return rows.map((row) => ({
    id: row.id,
    documentId: row.document_id,
    summary: row.summary,
    title: row.title,
    parentId: row.parent_id || undefined,
    microPaths: row.micro_paths_json || undefined,
    microPathsHash: row.micro_paths_hash || undefined,
    importance: typeof row.importance === "number" ? row.importance : undefined,
    linkAuditLog: row.link_audit_log || undefined,
    createdAt: row.created_at,
    author: row.author,
    sourceMetadata: row.source_metadata || undefined,
  }));
}

export async function addDocumentAuditLog(
  documentId: string,
  kind: string,
  payload: Record<string, any>,
  context: MomentGraphContext
): Promise<void> {
  const db = getMomentDb(context);
  const safeDocumentId =
    typeof documentId === "string" ? documentId.trim() : "";
  const safeKind = typeof kind === "string" ? kind.trim() : "";
  if (safeDocumentId.length === 0 || safeKind.length === 0) {
    return;
  }

  const createdAt = new Date().toISOString();
  await db
    .insertInto("document_audit_logs")
    .values({
      id: crypto.randomUUID(),
      document_id: safeDocumentId,
      kind: safeKind,
      payload_json: JSON.stringify(payload ?? {}),
      created_at: createdAt,
    })
    .execute();
}

export async function getDocumentAuditLogsForDocument(
  documentId: string,
  context: MomentGraphContext,
  options?: { kindPrefix?: string | null; limit?: number }
): Promise<
  Array<{
    id: string;
    documentId: string;
    kind: string;
    createdAt: string;
    payload: Record<string, any>;
  }>
> {
  const db = getMomentDb(context);
  const safeDocumentId =
    typeof documentId === "string" ? documentId.trim() : "";
  if (safeDocumentId.length === 0) {
    return [];
  }

  const kindPrefixRaw = options?.kindPrefix;
  const kindPrefix =
    typeof kindPrefixRaw === "string" && kindPrefixRaw.trim().length > 0
      ? kindPrefixRaw.trim()
      : null;

  const limitRaw = options?.limit;
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.floor(limitRaw)
      : 20;

  let query = db
    .selectFrom("document_audit_logs")
    .selectAll()
    .where("document_id", "=", safeDocumentId);

  if (kindPrefix) {
    query = query.where("kind", "like", `${kindPrefix}%`);
  }

  const rows = (await query
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute()) as unknown as DocumentAuditRow[];

  return rows.map((row) => ({
    id: row.id,
    documentId: row.document_id,
    kind: row.kind,
    createdAt: row.created_at,
    payload: row.payload_json ?? {},
  }));
}

export async function getRecentDocumentAuditEvents(
  context: MomentGraphContext,
  options?: {
    kindPrefixes?: string[];
    limitEvents?: number;
    limitDocuments?: number;
  }
): Promise<
  Array<{
    id: string;
    documentId: string;
    kind: string;
    createdAt: string;
    payload: Record<string, any>;
  }>
> {
  const db = getMomentDb(context);
  const kindPrefixesRaw = options?.kindPrefixes;
  const kindPrefixes =
    Array.isArray(kindPrefixesRaw) &&
    kindPrefixesRaw.every((s) => typeof s === "string")
      ? kindPrefixesRaw.map((s) => s.trim()).filter((s) => s.length > 0)
      : [];

  const limitEventsRaw = options?.limitEvents;
  const limitEvents =
    typeof limitEventsRaw === "number" &&
    Number.isFinite(limitEventsRaw) &&
    limitEventsRaw > 0
      ? Math.floor(limitEventsRaw)
      : 200;

  const limitDocumentsRaw = options?.limitDocuments;
  const limitDocuments =
    typeof limitDocumentsRaw === "number" &&
    Number.isFinite(limitDocumentsRaw) &&
    limitDocumentsRaw > 0
      ? Math.floor(limitDocumentsRaw)
      : 30;

  let query = db.selectFrom("document_audit_logs").selectAll();

  if (kindPrefixes.length > 0) {
    query = query.where((eb) =>
      eb.or(kindPrefixes.map((p) => eb("kind", "like", `${p}%`)))
    );
  }

  const rows = (await query
    .orderBy("created_at", "desc")
    .limit(limitEvents)
    .execute()) as unknown as DocumentAuditRow[];

  const out: Array<{
    id: string;
    documentId: string;
    kind: string;
    createdAt: string;
    payload: Record<string, any>;
  }> = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (seen.has(row.document_id)) {
      continue;
    }
    seen.add(row.document_id);
    out.push({
      id: row.id,
      documentId: row.document_id,
      kind: row.kind,
      createdAt: row.created_at,
      payload: row.payload_json ?? {},
    });
    if (out.length >= limitDocuments) {
      break;
    }
  }

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

export async function getMicroMomentsByPaths(
  documentId: string,
  paths: string[],
  context: MomentGraphContext
): Promise<MicroMoment[]> {
  if (paths.length === 0) {
    return [];
  }

  const uniquePaths = Array.from(
    new Set(paths.filter((p) => typeof p === "string" && p.length > 0))
  );
  if (uniquePaths.length === 0) {
    return [];
  }

  const remaining = new Set(uniquePaths);
  const outByPath = new Map<string, MicroMoment>();

  const db = getMomentDb(context);
  const rows = (await db
    .selectFrom("micro_moment_batches")
    .select(["items_json"])
    .where("document_id", "=", documentId)
    .execute()) as unknown as Pick<MicroMomentBatchRow, "items_json">[];

  for (const row of rows) {
    for (const item of row.items_json) {
      if (remaining.has(item.path)) {
        outByPath.set(item.path, item);
        remaining.delete(item.path);
        if (remaining.size === 0) {
          break;
        }
      }
    }
    if (remaining.size === 0) {
      break;
    }
  }

  return uniquePaths
    .map((p) => outByPath.get(p))
    .filter(Boolean) as MicroMoment[];
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

export async function getRootStatsByHighImportanceSample(
  context: MomentGraphContext,
  options?: {
    highImportanceCutoff?: number;
    sampleLimit?: number;
    limit?: number;
    maxParentHops?: number;
  }
): Promise<
  Array<{
    rootId: string;
    rootTitle: string | null;
    rootDocumentId: string | null;
    sampledHighImportanceCount: number;
    sampledImportanceSum: number;
    sampledImportanceMax: number | null;
  }>
> {
  const db = getMomentDb(context);

  const highCutoffRaw = options?.highImportanceCutoff;
  const highImportanceCutoff =
    typeof highCutoffRaw === "number" && Number.isFinite(highCutoffRaw)
      ? highCutoffRaw
      : 0.8;

  const sampleLimitRaw = options?.sampleLimit;
  const sampleLimit =
    typeof sampleLimitRaw === "number" &&
    Number.isFinite(sampleLimitRaw) &&
    sampleLimitRaw > 0
      ? Math.floor(sampleLimitRaw)
      : 2000;

  const limitRaw = options?.limit;
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.floor(limitRaw)
      : 20;

  const maxParentHopsRaw = options?.maxParentHops;
  const maxParentHops =
    typeof maxParentHopsRaw === "number" &&
    Number.isFinite(maxParentHopsRaw) &&
    maxParentHopsRaw > 0
      ? Math.floor(maxParentHopsRaw)
      : 200;

  type MomentRowSlim = {
    id: string;
    parent_id: string | null;
    title: string | null;
    document_id: string | null;
    importance: number | null;
  };

  const sampleRows = (await db
    .selectFrom("moments")
    .select(["id", "parent_id", "title", "document_id", "importance"])
    .where("importance", ">=", highImportanceCutoff as any)
    .orderBy("importance", "desc")
    .limit(sampleLimit)
    .execute()) as unknown as MomentRowSlim[];

  if (sampleRows.length === 0) {
    return [];
  }

  const sampledIds = new Set<string>();
  for (const row of sampleRows) {
    if (typeof row.id === "string" && row.id.length > 0) {
      sampledIds.add(row.id);
    }
  }

  const rowsById = new Map<string, MomentRowSlim>();
  for (const row of sampleRows) {
    rowsById.set(row.id, row);
  }

  let frontier = new Set<string>();
  for (const row of sampleRows) {
    if (typeof row.parent_id === "string" && row.parent_id.length > 0) {
      if (!rowsById.has(row.parent_id)) {
        frontier.add(row.parent_id);
      }
    }
  }

  const batchSize = 250;
  for (let hop = 0; hop < maxParentHops && frontier.size > 0; hop++) {
    const ids = Array.from(frontier);
    frontier = new Set<string>();

    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const fetched = (await db
        .selectFrom("moments")
        .select(["id", "parent_id", "title", "document_id", "importance"])
        .where("id", "in", batch)
        .execute()) as unknown as MomentRowSlim[];

      for (const row of fetched) {
        if (!rowsById.has(row.id)) {
          rowsById.set(row.id, row);
        }
      }

      for (const row of fetched) {
        const pid = typeof row.parent_id === "string" ? row.parent_id : null;
        if (pid && !rowsById.has(pid)) {
          frontier.add(pid);
        }
      }
    }
  }

  function findRootId(startId: string): string {
    let current = startId;
    const visited = new Set<string>();
    for (let depth = 0; depth < maxParentHops; depth++) {
      if (visited.has(current)) {
        return current;
      }
      visited.add(current);

      const row = rowsById.get(current);
      const parentId =
        row && typeof row.parent_id === "string" && row.parent_id.length > 0
          ? row.parent_id
          : null;
      if (!parentId) {
        return current;
      }
      if (!rowsById.has(parentId)) {
        return current;
      }
      current = parentId;
    }
    return current;
  }

  const aggByRoot = new Map<
    string,
    { count: number; sum: number; max: number | null }
  >();

  for (const row of sampleRows) {
    const rootId = findRootId(row.id);
    const agg = aggByRoot.get(rootId) ?? { count: 0, sum: 0, max: null };
    agg.count += 1;

    const importance =
      typeof row.importance === "number" && Number.isFinite(row.importance)
        ? row.importance
        : null;
    if (importance !== null) {
      agg.sum += importance;
      if (agg.max === null || importance > agg.max) {
        agg.max = importance;
      }
    }

    aggByRoot.set(rootId, agg);
  }

  const out = Array.from(aggByRoot.entries()).map(([rootId, agg]) => {
    const rootRow = rowsById.get(rootId);
    return {
      rootId,
      rootTitle: rootRow?.title ?? null,
      rootDocumentId: rootRow?.document_id ?? null,
      sampledHighImportanceCount: agg.count,
      sampledImportanceSum: agg.sum,
      sampledImportanceMax: agg.max,
    };
  });

  out.sort((a, b) => {
    if (a.sampledHighImportanceCount !== b.sampledHighImportanceCount) {
      return b.sampledHighImportanceCount - a.sampledHighImportanceCount;
    }
    if (a.sampledImportanceSum !== b.sampledImportanceSum) {
      return b.sampledImportanceSum - a.sampledImportanceSum;
    }
    return a.rootId.localeCompare(b.rootId);
  });

  return out.slice(0, limit);
}

export async function getKnowledgeGraphStructure(
  context: MomentGraphContext,
  options?: {
    limit?: number;
    maxDepth?: number;
  }
): Promise<Array<{ id: string; title: string; parentId: string | null }>> {
  const db = getMomentDb(context);

  const limitRaw = options?.limit;
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.floor(limitRaw)
      : 1000; // Default limit to prevent overwhelming the UI

  const rows = (await db
    .selectFrom("moments")
    .select(["id", "title", "parent_id"])
    .orderBy("created_at", "asc")
    .limit(limit)
    .execute()) as Array<{
    id: string;
    title: string;
    parent_id: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    title: row.title || `Moment ${row.id.substring(0, 8)}`,
    parentId: row.parent_id,
  }));
}

export async function getRootMoments(
  context: MomentGraphContext,
  options?: {
    limit?: number;
  }
): Promise<
  Array<{
    id: string;
    title: string;
    parentId: string | null;
    createdAt: string;
    descendantCount: number;
  }>
> {
  const db = getMomentDb(context);

  const limitRaw = options?.limit;
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.floor(limitRaw)
      : 1000;

  const rows = (await db
    .selectFrom("moments")
    .select(["id", "title", "parent_id", "created_at"])
    .where("parent_id", "is", null)
    .orderBy("created_at", "asc")
    .limit(limit)
    .execute()) as Array<{
    id: string;
    title: string;
    parent_id: string | null;
    created_at: string;
  }>;

  // Fetch all parent-child relationships to compute descendant counts
  const allRows = (await db
    .selectFrom("moments")
    .select(["id", "parent_id"])
    .execute()) as Array<{
    id: string;
    parent_id: string | null;
  }>;

  // Build a map of parent -> children
  const childrenByParent = new Map<string, string[]>();
  for (const row of allRows) {
    if (row.parent_id) {
      const children = childrenByParent.get(row.parent_id) || [];
      children.push(row.id);
      childrenByParent.set(row.parent_id, children);
    }
  }

  // Compute descendant count for each root using DFS
  function countDescendants(rootId: string): number {
    const visited = new Set<string>();
    let count = 0;

    function visit(id: string) {
      if (visited.has(id)) return;
      visited.add(id);
      const children = childrenByParent.get(id) || [];
      count += children.length;
      for (const childId of children) {
        visit(childId);
      }
    }

    visit(rootId);
    return count;
  }

  return rows.map((row) => ({
    id: row.id,
    title: row.title || `Moment ${row.id.substring(0, 8)}`,
    parentId: row.parent_id,
    createdAt: row.created_at,
    descendantCount: countDescendants(row.id),
  }));
}

export async function getDescendantsForRoot(
  rootId: string,
  context: MomentGraphContext
): Promise<Moment[]> {
  const descendants = await findDescendants(rootId, context);
  return descendants;
}

export async function getDescendantsForRootSlim(
  rootId: string,
  context: MomentGraphContext,
  options?: { maxNodes?: number }
): Promise<{ nodes: DescendantNode[]; truncated: boolean }> {
  return await findDescendantsSlim(rootId, context, options);
}

export async function getKnowledgeGraphStats(
  context: MomentGraphContext
): Promise<{
  totalMoments: number;
  rootMoments: number;
  momentsWithParent: number;
}> {
  const db = getMomentDb(context);

  const totalCount = await db
    .selectFrom("moments")
    .select(({ fn }) => [fn.count<number>("id").as("count")])
    .executeTakeFirst();

  const rootCount = await db
    .selectFrom("moments")
    .select(({ fn }) => [fn.count<number>("id").as("count")])
    .where("parent_id", "is", null)
    .executeTakeFirst();

  const withParentCount = await db
    .selectFrom("moments")
    .select(({ fn }) => [fn.count<number>("id").as("count")])
    .where("parent_id", "is not", null)
    .executeTakeFirst();

  return {
    totalMoments: Number(totalCount?.count ?? 0),
    rootMoments: Number(rootCount?.count ?? 0),
    momentsWithParent: Number(withParentCount?.count ?? 0),
  };
}
