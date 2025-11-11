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

export async function getIndexingState(r2Key: string): Promise<{
  r2_key: string;
  etag: string;
  indexed_at: string;
  chunk_ids: string[] | null;
} | null> {
  const db = createDb<IndexingStateDatabase>(
    (env as any)
      .ENGINE_INDEXING_STATE as DurableObjectNamespace<EngineIndexingStateDO>,
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

  console.log(
    `[db] getIndexingState for ${r2Key}: chunk_ids raw value type=${typeof state.chunk_ids}, value=${String(
      state.chunk_ids
    ).substring(0, 200)}`
  );

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
  console.log(
    `[db] updateIndexingState called for ${r2Key}: chunkIds type=${typeof chunkIds}, isArray=${Array.isArray(
      chunkIds
    )}, length=${Array.isArray(chunkIds) ? chunkIds.length : "N/A"}, firstFew=${
      Array.isArray(chunkIds) && chunkIds.length > 0
        ? JSON.stringify(chunkIds.slice(0, 3))
        : "empty"
    }`
  );

  const db = createDb<IndexingStateDatabase>(
    (env as any)
      .ENGINE_INDEXING_STATE as DurableObjectNamespace<EngineIndexingStateDO>,
    "engine-indexing-state"
  );

  const now = new Date().toISOString();
  const chunkIdsJson = JSON.stringify(chunkIds);
  console.log(
    `[db] updateIndexingState: JSON.stringify result length=${
      chunkIdsJson.length
    }, preview=${chunkIdsJson.substring(0, 200)}`
  );

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
        chunk_ids: chunkIdsJson,
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
        chunk_ids: chunkIdsJson,
      })
      .execute();
  }
}

export { EngineIndexingStateDO } from "./durableObject";
export { indexingStateMigrations } from "./migrations";
