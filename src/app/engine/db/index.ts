import { env } from "cloudflare:workers";
import { type Database, createDb } from "rwsdk/db";
import { type indexingStateMigrations } from "./migrations";
import type { EngineIndexingStateDO } from "./durableObject";

type IndexingStateDatabase = Database<typeof indexingStateMigrations>;

declare module "rwsdk/worker" {
  interface WorkerEnv {
    ENGINE_INDEXING_STATE: DurableObjectNamespace<EngineIndexingStateDO>;
  }
}

export async function getIndexingState(
  r2Key: string
): Promise<{
  r2_key: string;
  etag: string;
  indexed_at: string;
  chunk_ids: string[] | null;
} | null> {
  const db = createDb<IndexingStateDatabase>(
    (env as any).ENGINE_INDEXING_STATE as DurableObjectNamespace<EngineIndexingStateDO>,
    "engine-indexing-state"
  );

  const state = await db
    .selectFrom("indexing_state")
    .selectAll()
    .where("r2_key", "=", r2Key)
    .executeTakeFirst();

  if (!state) {
    return null;
  }

  return {
    r2_key: state.r2_key,
    etag: state.etag,
    indexed_at: state.indexed_at,
    chunk_ids: state.chunk_ids ? JSON.parse(state.chunk_ids) : null,
  };
}

export async function updateIndexingState(
  r2Key: string,
  etag: string,
  chunkIds: string[]
): Promise<void> {
  const db = createDb<IndexingStateDatabase>(
    (env as any).ENGINE_INDEXING_STATE as DurableObjectNamespace<EngineIndexingStateDO>,
    "engine-indexing-state"
  );

  const now = new Date().toISOString();

  const existing = await db
    .selectFrom("indexing_state")
    .selectAll()
    .where("r2_key", "=", r2Key)
    .executeTakeFirst();

  if (existing) {
    await db
      .updateTable("indexing_state")
      .set({
        etag,
        indexed_at: now,
        chunk_ids: JSON.stringify(chunkIds),
      })
      .where("r2_key", "=", r2Key)
      .execute();
  } else {
    await db
      .insertInto("indexing_state")
      .values({
        r2_key: r2Key,
        etag,
        indexed_at: now,
        chunk_ids: JSON.stringify(chunkIds),
      })
      .execute();
  }
}

export { EngineIndexingStateDO } from "./durableObject";
export { indexingStateMigrations } from "./migrations";
