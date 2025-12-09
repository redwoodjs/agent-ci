import { MomentGraphDO } from "./durableObject";
import type { Moment } from "../types";
import { type Database, createDb } from "rwsdk/db";
import { type momentMigrations } from "./migrations";

export { MomentGraphDO };

type MomentDatabase = Database<typeof momentMigrations>;

function getMomentDb(env: Cloudflare.Env) {
  return createDb<MomentDatabase>(
    env.MOMENT_GRAPH_DO as DurableObjectNamespace<MomentGraphDO>,
    "moment-graph"
  );
}

export async function addMoment(
  env: Cloudflare.Env,
  moment: Moment
): Promise<void> {
  const db = getMomentDb(env);
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
  env: Cloudflare.Env,
  id: string
): Promise<Moment | null> {
  const db = getMomentDb(env);
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
    createdAt: row.created_at,
    author: row.author,
    sourceMetadata: row.source_metadata
      ? (JSON.parse(row.source_metadata) as Record<string, any>)
      : undefined,
  };
}

export async function findAncestors(
  env: Cloudflare.Env,
  momentId: string
): Promise<Moment[]> {
  const ancestors: Moment[] = [];
  let currentMomentId: string | undefined = momentId;

  while (currentMomentId) {
    const moment = await getMoment(env, currentMomentId);
    if (moment) {
      ancestors.unshift(moment);
      currentMomentId = moment.parentId;
    } else {
      currentMomentId = undefined;
    }
  }

  return ancestors;
}

export async function findLastMomentForDocument(
  env: Cloudflare.Env,
  documentId: string
): Promise<Moment | null> {
  const db = getMomentDb(env);
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
      ? (JSON.parse(row.source_metadata) as Record<string, any>)
      : undefined,
  };
}
