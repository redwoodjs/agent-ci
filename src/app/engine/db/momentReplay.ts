import { type Database, createDb, sql } from "rwsdk/db";
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

export type ReplayOrder = "ascending" | "descending";

export async function getRecentReplayRunsForPrefix(
  context: ReplayDbContext,
  input: { momentGraphNamespacePrefix: string; limit?: number }
): Promise<
  Array<{
    runId: string;
    status: string;
    startedAt: string;
    updatedAt: string;
    expectedDocuments: number;
    processedDocuments: number;
    succeededDocuments: number;
    failedDocuments: number;
    replayedItems: number;
    replayEnqueued: boolean;
    momentGraphNamespace: string | null;
    momentGraphNamespacePrefix: string | null;
    replayOrder: ReplayOrder;
    totalItems: number;
    pendingItems: number;
    doneItems: number;
  }>
> {
  const db = getReplayDb(context);
  const prefix =
    typeof input.momentGraphNamespacePrefix === "string" &&
    input.momentGraphNamespacePrefix.trim().length > 0
      ? input.momentGraphNamespacePrefix.trim()
      : "";
  if (!prefix) {
    return [];
  }
  const limitRaw = input.limit;
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.floor(limitRaw)
      : 10;

  const rows = (await db
    .selectFrom("moment_replay_runs")
    .selectAll()
    .where("moment_graph_namespace_prefix", "=", prefix)
    .orderBy("updated_at", "desc")
    .limit(limit)
    .execute()) as unknown as MomentReplayRunRow[];

  const runIds = rows
    .map((row) => (row as any).run_id)
    .filter((v): v is string => typeof v === "string" && v.length > 0);

  const statusCountsRows =
    runIds.length > 0
      ? ((await db
          .selectFrom("moment_replay_items")
          .select(["run_id", "status"])
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("run_id", "in", runIds)
          .groupBy(["run_id", "status"])
          .execute()) as unknown as Array<{
          run_id: string;
          status: string;
          count: number;
        }>)
      : [];

  const countsByRunId = new Map<
    string,
    { total: number; pending: number; done: number }
  >();
  for (const r of statusCountsRows) {
    const rid = (r as any).run_id;
    const status = String((r as any).status ?? "");
    const count = Number((r as any).count ?? 0);
    if (typeof rid !== "string" || rid.length === 0) {
      continue;
    }
    const existing = countsByRunId.get(rid) ?? {
      total: 0,
      pending: 0,
      done: 0,
    };
    existing.total += count;
    if (status === "pending") {
      existing.pending += count;
    }
    if (status === "done") {
      existing.done += count;
    }
    countsByRunId.set(rid, existing);
  }

  return rows.map((row) => {
    const runId = (row as any).run_id as string;
    const counts = countsByRunId.get(runId) ?? {
      total: 0,
      pending: 0,
      done: 0,
    };
    return {
      runId: (row as any).run_id as string,
      status: (row as any).status as string,
      startedAt: (row as any).started_at as string,
      updatedAt: (row as any).updated_at as string,
      expectedDocuments: Number((row as any).expected_documents ?? 0),
      processedDocuments: Number((row as any).processed_documents ?? 0),
      succeededDocuments: Number((row as any).succeeded_documents ?? 0),
      failedDocuments: Number((row as any).failed_documents ?? 0),
      replayedItems: Number((row as any).replayed_items ?? 0),
      replayEnqueued: Number((row as any).replay_enqueued ?? 0) === 1,
      momentGraphNamespace: (row as any).moment_graph_namespace ?? null,
      momentGraphNamespacePrefix:
        (row as any).moment_graph_namespace_prefix ?? null,
      replayOrder:
        (row as any).replay_order === "descending" ? "descending" : "ascending",
      totalItems: counts.total,
      pendingItems: counts.pending,
      doneItems: counts.done,
    };
  });
}

export async function createMomentReplayRun(
  context: ReplayDbContext,
  input: {
    runId: string;
    momentGraphNamespace: string | null;
    momentGraphNamespacePrefix: string | null;
    expectedDocuments: number;
    replayOrder?: ReplayOrder | null;
  }
): Promise<void> {
  const db = getReplayDb(context);
  const now = new Date().toISOString();
  const replayOrder =
    input.replayOrder === "descending" ? "descending" : "ascending";
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
      processed_documents: 0 as any,
      succeeded_documents: 0 as any,
      failed_documents: 0 as any,
      replay_enqueued: 0 as any,
      replayed_items: 0 as any,
      replay_cursor_json: JSON.stringify({
        lastOrderMs: null,
        lastItemId: null,
      } satisfies ReplayCursor),
      replay_order: replayOrder,
    } as any)
    .execute();
}

export async function recordReplayDocumentResult(
  context: ReplayDbContext,
  input: {
    runId: string;
    r2Key: string;
    status: "succeeded" | "failed";
    errorPayload?: Record<string, any> | null;
  }
): Promise<{
  expectedDocuments: number;
  processedDocuments: number;
  succeededDocuments: number;
  failedDocuments: number;
  replayEnqueued: boolean;
  momentGraphNamespace: string | null;
  momentGraphNamespacePrefix: string | null;
} | null> {
  const db = getReplayDb(context);
  const now = new Date().toISOString();

  const run = (await db
    .selectFrom("moment_replay_runs")
    .selectAll()
    .where("run_id", "=", input.runId)
    .executeTakeFirst()) as MomentReplayRunRow | undefined;

  if (!run) {
    return null;
  }

  const r2Key =
    typeof input.r2Key === "string" && input.r2Key.trim().length > 0
      ? input.r2Key.trim()
      : "";
  if (!r2Key) {
    return null;
  }

  const errorJson =
    input.status === "failed"
      ? JSON.stringify(input.errorPayload ?? { message: "unknown error" })
      : null;

  const insertResult = await db
    .insertInto("moment_replay_document_results")
    .values({
      run_id: input.runId,
      r2_key: r2Key,
      status: input.status,
      error_json: errorJson,
      created_at: now,
      updated_at: now,
    } as any)
    .onConflict((oc) => oc.columns(["run_id", "r2_key"]).doNothing())
    .executeTakeFirst();

  const insertedRows =
    typeof (insertResult as any)?.numInsertedOrUpdatedRows === "bigint"
      ? Number((insertResult as any).numInsertedOrUpdatedRows)
      : Number((insertResult as any)?.numInsertedOrUpdatedRows ?? 0);
  const didInsert = insertedRows > 0;

  if (!didInsert) {
    await db
      .updateTable("moment_replay_document_results")
      .set({
        status: input.status,
        error_json: errorJson,
        updated_at: now,
      } as any)
      .where("run_id", "=", input.runId)
      .where("r2_key", "=", r2Key)
      .execute();
  } else {
    const incSucceeded = input.status === "succeeded" ? 1 : 0;
    const incFailed = input.status === "failed" ? 1 : 0;

    await db
      .updateTable("moment_replay_runs")
      .set(({ eb }) => ({
        processed_documents: eb("processed_documents", "+", 1 as any) as any,
        succeeded_documents: eb(
          "succeeded_documents",
          "+",
          incSucceeded as any
        ) as any,
        failed_documents: eb("failed_documents", "+", incFailed as any) as any,
        updated_at: now,
      }))
      .where("run_id", "=", input.runId)
      .execute();
  }

  const updatedRun = (await db
    .selectFrom("moment_replay_runs")
    .selectAll()
    .where("run_id", "=", input.runId)
    .executeTakeFirst()) as MomentReplayRunRow | undefined;

  const runRow = updatedRun ?? run;

  return {
    expectedDocuments: Number((runRow as any).expected_documents ?? 0),
    processedDocuments: Number((runRow as any).processed_documents ?? 0),
    succeededDocuments: Number((runRow as any).succeeded_documents ?? 0),
    failedDocuments: Number((runRow as any).failed_documents ?? 0),
    replayEnqueued: Number((runRow as any).replay_enqueued ?? 0) === 1,
    momentGraphNamespace: (runRow as any).moment_graph_namespace ?? null,
    momentGraphNamespacePrefix:
      (runRow as any).moment_graph_namespace_prefix ?? null,
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
    items: Array<{
      itemId: string;
      effectiveNamespace: string;
      documentId?: string | null;
      streamId?: string | null;
      macroMomentIndex?: number | null;
      orderMs: number;
      payload: unknown;
    }>;
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
    effective_namespace: it.effectiveNamespace,
    document_id: it.documentId ?? null,
    stream_id: it.streamId ?? null,
    macro_moment_index:
      typeof it.macroMomentIndex === "number" &&
      Number.isFinite(it.macroMomentIndex)
        ? Math.floor(it.macroMomentIndex)
        : null,
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
      .onConflict((oc) =>
        oc.columns(["run_id", "item_id"]).doUpdateSet({
          effective_namespace: sql`excluded.effective_namespace` as any,
          document_id: sql`excluded.document_id` as any,
          stream_id: sql`excluded.stream_id` as any,
          macro_moment_index: sql`excluded.macro_moment_index` as any,
          order_ms: sql`excluded.order_ms` as any,
          payload_json: sql`excluded.payload_json` as any,
          status: "pending",
          updated_at: now,
        } as any)
      )
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

export async function resetReplayRunForReplay(
  context: ReplayDbContext,
  input: { runId: string; replayOrder?: ReplayOrder | null }
): Promise<boolean> {
  const db = getReplayDb(context);
  const runId =
    typeof input.runId === "string" && input.runId.trim().length > 0
      ? input.runId.trim()
      : "";
  if (!runId) {
    return false;
  }

  const now = new Date().toISOString();

  const runRow = await db
    .selectFrom("moment_replay_runs")
    .select(["run_id"])
    .where("run_id", "=", runId)
    .executeTakeFirst();

  if (!runRow) {
    return false;
  }

  const replayOrder = input.replayOrder === "descending" ? "descending" : null;

  await db
    .updateTable("moment_replay_runs")
    .set({
      status: "ready_to_replay",
      replay_enqueued: 0 as any,
      replayed_items: 0 as any,
      replay_cursor_json: JSON.stringify({
        lastOrderMs: null,
        lastItemId: null,
      } satisfies ReplayCursor),
      ...(replayOrder ? { replay_order: replayOrder } : null),
      updated_at: now,
    } as any)
    .where("run_id", "=", runId)
    .execute();

  await db
    .updateTable("moment_replay_items")
    .set({
      status: "pending",
      updated_at: now,
    } as any)
    .where("run_id", "=", runId)
    .execute();

  await db
    .deleteFrom("moment_replay_stream_state")
    .where("run_id", "=", runId)
    .execute();

  return true;
}

export async function getReplayRunOrder(
  context: ReplayDbContext,
  input: { runId: string }
): Promise<ReplayOrder> {
  const db = getReplayDb(context);
  const row = await db
    .selectFrom("moment_replay_runs")
    .select(["replay_order"])
    .where("run_id", "=", input.runId)
    .executeTakeFirst();
  const value = (row as any)?.replay_order;
  return value === "descending" ? "descending" : "ascending";
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
    .executeTakeFirst()) as
    | Pick<MomentReplayRunRow, "replay_cursor_json">
    | undefined;
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
      typeof (value as any).lastItemId === "string"
        ? (value as any).lastItemId
        : null,
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
  const next =
    current +
    (Number.isFinite(input.replayedItemsDelta) ? input.replayedItemsDelta : 0);

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
  input: {
    runId: string;
    effectiveNamespace: string;
    documentId: string;
    streamId: string;
  }
): Promise<string | null> {
  const db = getReplayDb(context);
  const row = await db
    .selectFrom("moment_replay_stream_state")
    .select(["last_moment_id"])
    .where("run_id", "=", input.runId)
    .where("effective_namespace", "=", input.effectiveNamespace)
    .where("document_id", "=", input.documentId)
    .where("stream_id", "=", input.streamId)
    .executeTakeFirst();
  const value = (row as any)?.last_moment_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function setReplayStreamState(
  context: ReplayDbContext,
  input: {
    runId: string;
    effectiveNamespace: string;
    documentId: string;
    streamId: string;
    lastMomentId: string | null;
  }
): Promise<void> {
  const db = getReplayDb(context);
  const now = new Date().toISOString();
  await db
    .insertInto("moment_replay_stream_state")
    .values({
      run_id: input.runId,
      effective_namespace: input.effectiveNamespace,
      document_id: input.documentId,
      stream_id: input.streamId,
      last_moment_id: input.lastMomentId,
      updated_at: now,
    } as any)
    .onConflict((oc) =>
      oc
        .columns(["run_id", "effective_namespace", "document_id", "stream_id"])
        .doUpdateSet({
          last_moment_id: input.lastMomentId,
          updated_at: now,
        } as any)
    )
    .execute();
}

export async function fetchReplayItemsBatch(
  context: ReplayDbContext,
  input: {
    runId: string;
    cursor: ReplayCursor;
    limit: number;
    replayOrder: ReplayOrder;
  }
): Promise<
  Array<{
    itemId: string;
    effectiveNamespace: string;
    orderMs: number;
    payload: any;
  }>
> {
  const db = getReplayDb(context);
  const limit =
    typeof input.limit === "number" &&
    Number.isFinite(input.limit) &&
    input.limit > 0
      ? Math.floor(input.limit)
      : 100;

  const lastOrderMs = input.cursor.lastOrderMs;
  const lastItemId = input.cursor.lastItemId;
  const replayOrder =
    input.replayOrder === "descending" ? "descending" : "ascending";

  const rows = (await db
    .selectFrom("moment_replay_items")
    .select(["item_id", "effective_namespace", "order_ms", "payload_json"])
    .where("run_id", "=", input.runId)
    .where("status", "=", "pending")
    .where((eb) => {
      if (replayOrder === "descending") {
        if (
          typeof lastOrderMs === "number" &&
          Number.isFinite(lastOrderMs) &&
          lastItemId
        ) {
          return eb.or([
            eb("order_ms", "<", lastOrderMs as any),
            eb.and([
              eb("order_ms", "=", lastOrderMs as any),
              eb("item_id", "<", lastItemId),
            ]),
          ]);
        }
        if (typeof lastOrderMs === "number" && Number.isFinite(lastOrderMs)) {
          return eb("order_ms", "<", lastOrderMs as any);
        }
        return eb("order_ms", ">=", 0 as any);
      }
      if (
        typeof lastOrderMs === "number" &&
        Number.isFinite(lastOrderMs) &&
        lastItemId
      ) {
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
    .orderBy("order_ms", replayOrder === "descending" ? "desc" : "asc")
    .orderBy("item_id", replayOrder === "descending" ? "desc" : "asc")
    .limit(limit)
    .execute()) as unknown as Array<
    Pick<
      MomentReplayItemRow,
      "item_id" | "effective_namespace" | "order_ms" | "payload_json"
    >
  >;

  return rows
    .map((r) => {
      return {
        itemId: (r as any).item_id as string,
        effectiveNamespace: (r as any).effective_namespace as string,
        orderMs: Number((r as any).order_ms ?? 0),
        payload: (r as any).payload_json,
      };
    })
    .filter((r) => typeof r.itemId === "string" && r.itemId.length > 0);
}

export async function setReplayItemsPendingOnlyForDocuments(
  context: ReplayDbContext,
  input: { runId: string; documentIds: string[] }
): Promise<{ matchedDocuments: number; matchedItems: number }> {
  const db = getReplayDb(context);
  const runId =
    typeof input.runId === "string" && input.runId.trim().length > 0
      ? input.runId.trim()
      : "";
  if (!runId) {
    return { matchedDocuments: 0, matchedItems: 0 };
  }
  const documentIds = Array.isArray(input.documentIds)
    ? input.documentIds
        .filter((d): d is string => typeof d === "string")
        .map((d) => d.trim())
        .filter((d) => d.length > 0)
    : [];
  if (documentIds.length === 0) {
    return { matchedDocuments: 0, matchedItems: 0 };
  }

  const matchRows = (await db
    .selectFrom("moment_replay_items")
    .select(["document_id"])
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("run_id", "=", runId)
    .where("document_id", "in", documentIds)
    .groupBy("document_id")
    .execute()) as unknown as Array<{
    document_id: string | null;
    count: number;
  }>;

  const matchedDocuments = matchRows.filter(
    (r) => typeof (r as any).document_id === "string" && (r as any).document_id
  ).length;
  const matchedItems = matchRows.reduce(
    (sum, r) => sum + Number((r as any).count ?? 0),
    0
  );

  if (matchedItems === 0) {
    return { matchedDocuments, matchedItems };
  }

  const now = new Date().toISOString();

  await db
    .updateTable("moment_replay_runs")
    .set({
      status: "ready_to_replay",
      replay_enqueued: 0 as any,
      replayed_items: 0 as any,
      replay_cursor_json: JSON.stringify({
        lastOrderMs: null,
        lastItemId: null,
      } satisfies ReplayCursor),
      updated_at: now,
    } as any)
    .where("run_id", "=", runId)
    .execute();

  await db
    .updateTable("moment_replay_items")
    .set({ status: "done", updated_at: now } as any)
    .where("run_id", "=", runId)
    .execute();

  await db
    .updateTable("moment_replay_items")
    .set({ status: "pending", updated_at: now } as any)
    .where("run_id", "=", runId)
    .where("document_id", "in", documentIds)
    .execute();

  await db
    .deleteFrom("moment_replay_stream_state")
    .where("run_id", "=", runId)
    .execute();

  return { matchedDocuments, matchedItems };
}

export async function markReplayItemsDone(
  context: ReplayDbContext,
  input: { runId: string; itemIds: string[] }
): Promise<void> {
  const ids = Array.isArray(input.itemIds)
    ? input.itemIds.filter(
        (id): id is string => typeof id === "string" && id.length > 0
      )
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
