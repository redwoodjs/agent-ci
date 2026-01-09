import { type Database, createDb } from "rwsdk/db";
import { type indexingStateMigrations } from "./migrations";
import type { EngineIndexingStateDO } from "./durableObject";
import { qualifyName } from "../momentGraphNamespace";
import { Override } from "@/app/shared/kyselyTypeOverrides";

type IndexingStateDatabase = Database<typeof indexingStateMigrations>;

type MomentReplayRunInput = IndexingStateDatabase["moment_replay_runs"];
type MomentReplayRunRow = Override<
  MomentReplayRunInput,
  {
    replay_cursor_json: ReplayCursor | null;
  }
>;

type MomentReplayItemInput = IndexingStateDatabase["moment_replay_items"];
type MomentReplayItemRow = Override<
  MomentReplayItemInput,
  {
    payload_json: any;
  }
>;

type ReplayDbContext = {
  env: Cloudflare.Env;
  momentGraphNamespace: string | null;
};

function getReplayDb(context: ReplayDbContext) {
  return createDb<IndexingStateDatabase>(
    (context.env as any)
      .ENGINE_INDEXING_STATE as DurableObjectNamespace<EngineIndexingStateDO>,
    qualifyName("engine-indexing-state", context.momentGraphNamespace)
  );
}

export type MomentReplayRunStatus =
  | "collecting"
  | "ready_to_replay"
  | "replaying"
  | "completed"
  | "paused_on_error";

export type ReplayCursor = {
  lastOrderMs: number | null;
  lastItemId: string | null;
};

export async function createMomentReplayRun(
  context: ReplayDbContext,
  input: {
    runId: string;
    momentGraphNamespace: string | null;
    momentGraphNamespacePrefix: string | null;
    expectedDocuments: number;
  }
): Promise<void> {
  const db = getReplayDb(context);
  const now = new Date().toISOString();
  await db
    .insertInto("moment_replay_runs")
    .values({
      run_id: input.runId,
      status: "collecting",
      started_at: now,
      updated_at: now,
      moment_graph_namespace: input.momentGraphNamespace,
      moment_graph_namespace_prefix: input.momentGraphNamespacePrefix,
      expected_documents: input.expectedDocuments as any,
      collected_documents: 0 as any,
      replay_enqueued: 0 as any,
      replayed_items: 0 as any,
      replay_cursor_json: JSON.stringify({
        lastOrderMs: null,
        lastItemId: null,
      } satisfies ReplayCursor),
    } as any)
    .execute();
}

export async function markDocumentCollected(
  context: ReplayDbContext,
  input: { runId: string }
): Promise<{
  expectedDocuments: number;
  collectedDocuments: number;
  replayEnqueued: boolean;
  momentGraphNamespace: string | null;
  momentGraphNamespacePrefix: string | null;
} | null> {
  const db = getReplayDb(context);
  const now = new Date().toISOString();

  const existing = (await db
    .selectFrom("moment_replay_runs")
    .selectAll()
    .where("run_id", "=", input.runId)
    .executeTakeFirst()) as MomentReplayRunRow | undefined;

  if (!existing) {
    return null;
  }

  const nextCollected = Number((existing as any).collected_documents ?? 0) + 1;
  await db
    .updateTable("moment_replay_runs")
    .set({
      collected_documents: nextCollected as any,
      updated_at: now,
    })
    .where("run_id", "=", input.runId)
    .execute();

  return {
    expectedDocuments: Number((existing as any).expected_documents ?? 0),
    collectedDocuments: nextCollected,
    replayEnqueued: Number((existing as any).replay_enqueued ?? 0) === 1,
    momentGraphNamespace: (existing as any).moment_graph_namespace ?? null,
    momentGraphNamespacePrefix: (existing as any).moment_graph_namespace_prefix ?? null,
  };
}

export async function setReplayEnqueued(
  context: ReplayDbContext,
  input: { runId: string }
): Promise<boolean> {
  const db = getReplayDb(context);
  const now = new Date().toISOString();

  const result = await db
    .updateTable("moment_replay_runs")
    .set({
      replay_enqueued: 1 as any,
      status: "ready_to_replay",
      updated_at: now,
    })
    .where("run_id", "=", input.runId)
    .where("replay_enqueued", "=", 0 as any)
    .executeTakeFirst();

  const updatedRows =
    typeof (result as any)?.numUpdatedRows === "bigint"
      ? Number((result as any).numUpdatedRows)
      : Number((result as any)?.numUpdatedRows ?? 0);

  return updatedRows > 0;
}

export async function addReplayItemsBatch(
  context: ReplayDbContext,
  input: {
    runId: string;
    items: Array<{ itemId: string; orderMs: number; payload: unknown }>;
  }
): Promise<void> {
  if (input.items.length === 0) {
    return;
  }

  const db = getReplayDb(context);
  const now = new Date().toISOString();

  const rows = input.items.map((it) => ({
    run_id: input.runId,
    item_id: it.itemId,
    order_ms: it.orderMs as any,
    payload_json: JSON.stringify(it.payload),
    status: "pending",
    created_at: now,
    updated_at: now,
  }));

  const batchSize = 100;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    await db
      .insertInto("moment_replay_items")
      .values(batch as any)
      .onConflict((oc) => oc.columns(["run_id", "item_id"]).doNothing())
      .execute();
  }
}

export async function setReplayRunStatus(
  context: ReplayDbContext,
  input: { runId: string; status: MomentReplayRunStatus }
): Promise<void> {
  const db = getReplayDb(context);
  await db
    .updateTable("moment_replay_runs")
    .set({
      status: input.status,
      updated_at: new Date().toISOString(),
    })
    .where("run_id", "=", input.runId)
    .execute();
}

export async function getReplayCursor(
  context: ReplayDbContext,
  input: { runId: string }
): Promise<ReplayCursor | null> {
  const db = getReplayDb(context);
  const row = (await db
    .selectFrom("moment_replay_runs")
    .select(["replay_cursor_json"])
    .where("run_id", "=", input.runId)
    .executeTakeFirst()) as Pick<MomentReplayRunRow, "replay_cursor_json"> | undefined;
  const value = row?.replay_cursor_json;
  if (!value) {
    return { lastOrderMs: null, lastItemId: null };
  }
  return {
    lastOrderMs:
      typeof (value as any).lastOrderMs === "number" &&
      Number.isFinite((value as any).lastOrderMs)
        ? (value as any).lastOrderMs
        : null,
    lastItemId:
      typeof (value as any).lastItemId === "string" ? (value as any).lastItemId : null,
  };
}

export async function setReplayCursor(
  context: ReplayDbContext,
  input: { runId: string; cursor: ReplayCursor; replayedItemsDelta: number }
): Promise<void> {
  const db = getReplayDb(context);
  const existing = await db
    .selectFrom("moment_replay_runs")
    .select(["replayed_items"])
    .where("run_id", "=", input.runId)
    .executeTakeFirst();
  const current = Number((existing as any)?.replayed_items ?? 0);
  const next = current + (Number.isFinite(input.replayedItemsDelta) ? input.replayedItemsDelta : 0);

  await db
    .updateTable("moment_replay_runs")
    .set({
      replay_cursor_json: JSON.stringify(input.cursor),
      replayed_items: next as any,
      updated_at: new Date().toISOString(),
    })
    .where("run_id", "=", input.runId)
    .execute();
}

export async function getReplayStreamState(
  context: ReplayDbContext,
  input: { runId: string; documentId: string; streamId: string }
): Promise<string | null> {
  const db = getReplayDb(context);
  const row = await db
    .selectFrom("moment_replay_stream_state")
    .select(["last_moment_id"])
    .where("run_id", "=", input.runId)
    .where("document_id", "=", input.documentId)
    .where("stream_id", "=", input.streamId)
    .executeTakeFirst();
  const value = (row as any)?.last_moment_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function setReplayStreamState(
  context: ReplayDbContext,
  input: { runId: string; documentId: string; streamId: string; lastMomentId: string | null }
): Promise<void> {
  const db = getReplayDb(context);
  const now = new Date().toISOString();
  await db
    .insertInto("moment_replay_stream_state")
    .values({
      run_id: input.runId,
      document_id: input.documentId,
      stream_id: input.streamId,
      last_moment_id: input.lastMomentId,
      updated_at: now,
    } as any)
    .onConflict((oc) =>
      oc.columns(["run_id", "document_id", "stream_id"]).doUpdateSet({
        last_moment_id: input.lastMomentId,
        updated_at: now,
      } as any)
    )
    .execute();
}

export async function fetchReplayItemsBatch(
  context: ReplayDbContext,
  input: { runId: string; cursor: ReplayCursor; limit: number }
): Promise<Array<{ itemId: string; orderMs: number; payload: any }>> {
  const db = getReplayDb(context);
  const limit =
    typeof input.limit === "number" && Number.isFinite(input.limit) && input.limit > 0
      ? Math.floor(input.limit)
      : 100;

  const lastOrderMs = input.cursor.lastOrderMs;
  const lastItemId = input.cursor.lastItemId;

  const rows = (await db
    .selectFrom("moment_replay_items")
    .select(["item_id", "order_ms", "payload_json"])
    .where("run_id", "=", input.runId)
    .where("status", "=", "pending")
    .where((eb) => {
      if (typeof lastOrderMs === "number" && Number.isFinite(lastOrderMs) && lastItemId) {
        return eb.or([
          eb("order_ms", ">", lastOrderMs as any),
          eb.and([
            eb("order_ms", "=", lastOrderMs as any),
            eb("item_id", ">", lastItemId),
          ]),
        ]);
      }
      if (typeof lastOrderMs === "number" && Number.isFinite(lastOrderMs)) {
        return eb("order_ms", ">", lastOrderMs as any);
      }
      return eb("order_ms", ">=", 0 as any);
    })
    .orderBy("order_ms", "asc")
    .orderBy("item_id", "asc")
    .limit(limit)
    .execute()) as Array<Pick<MomentReplayItemRow, "item_id" | "order_ms" | "payload_json">>;

  return rows
    .map((r) => {
      return {
        itemId: (r as any).item_id as string,
        orderMs: Number((r as any).order_ms ?? 0),
        payload: (r as any).payload_json,
      };
    })
    .filter((r) => typeof r.itemId === "string" && r.itemId.length > 0);
}

export async function markReplayItemsDone(
  context: ReplayDbContext,
  input: { runId: string; itemIds: string[] }
): Promise<void> {
  const ids = Array.isArray(input.itemIds)
    ? input.itemIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (ids.length === 0) {
    return;
  }
  const db = getReplayDb(context);
  await db
    .updateTable("moment_replay_items")
    .set({
      status: "done",
      updated_at: new Date().toISOString(),
    })
    .where("run_id", "=", input.runId)
    .where("item_id", "in", ids)
    .execute();
}

