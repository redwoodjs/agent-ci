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
  console.log(`[db] getIndexingState called for: ${r2Key}`);

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
    console.log(`[db] getIndexingState: no state found for ${r2Key}`);
    return null;
  }

  let chunkIds: string[] | null = null;
  if (state.chunk_ids) {
    if (Array.isArray(state.chunk_ids)) {
      chunkIds = state.chunk_ids;
    } else {
      console.warn(
        `[db] Invalid chunk_ids for ${r2Key}: expected array (already parsed by ParseJSONResultsPlugin), got ${typeof state.chunk_ids}. Value: ${JSON.stringify(
          state.chunk_ids
        ).substring(0, 200)}`
      );
    }
  }

  console.log(
    `[db] getIndexingState: found state for ${r2Key}, etag=${
      state.etag
    }, chunk_ids=${chunkIds ? chunkIds.length : 0} items`
  );

  return {
    r2_key: state.r2_key,
    etag: state.etag,
    indexed_at: state.indexed_at,
    chunk_ids: chunkIds,
  };
}

export async function getIndexingStatesBatch(r2Keys: string[]): Promise<
  Map<
    string,
    {
      r2_key: string;
      etag: string;
      indexed_at: string;
      chunk_count: number;
    }
  >
> {
  if (r2Keys.length === 0) {
    return new Map();
  }

  console.log(`[db] getIndexingStatesBatch called for ${r2Keys.length} keys`);

  const db = createDb<IndexingStateDatabase>(
    (env as any)
      .ENGINE_INDEXING_STATE as DurableObjectNamespace<EngineIndexingStateDO>,
    "engine-indexing-state"
  );

  const result = new Map<
    string,
    {
      r2_key: string;
      etag: string;
      indexed_at: string;
      chunk_count: number;
    }
  >();

  const maxBatchSize = 100;
  for (let i = 0; i < r2Keys.length; i += maxBatchSize) {
    const batch = r2Keys.slice(i, i + maxBatchSize);

    const states = await db
      .selectFrom("indexing_state")
      .select(["r2_key", "etag", "indexed_at", "processed_chunk_hashes_json"])
      .where("r2_key", "in", batch)
      .execute();

    for (const state of states) {
      // Kysely plugin auto-parses JSON fields, so this is already an array
      const chunkCount = Array.isArray(state.processed_chunk_hashes_json)
        ? state.processed_chunk_hashes_json.length
        : 0;
      result.set(state.r2_key, {
        r2_key: state.r2_key,
        etag: state.etag,
        indexed_at: state.indexed_at,
        chunk_count: chunkCount,
      });
    }
  }

  console.log(
    `[db] getIndexingStatesBatch: found ${result.size} states out of ${r2Keys.length} requested`
  );

  return result;
}

export async function updateIndexingState(
  r2Key: string,
  etag: string,
  chunkIds: string[]
): Promise<void> {
  console.log(
    `[db] updateIndexingState called for ${r2Key}: etag=${etag}, chunkIds=${chunkIds.length} items`
  );

  const db = createDb<IndexingStateDatabase>(
    (env as any)
      .ENGINE_INDEXING_STATE as DurableObjectNamespace<EngineIndexingStateDO>,
    "engine-indexing-state"
  );

  const now = new Date().toISOString();
  const chunkIdsJson = JSON.stringify(chunkIds);

  const existing = await db
    .selectFrom("indexing_state")
    .selectAll()
    .where("r2_key", "=", r2Key)
    .executeTakeFirst();

  if (existing) {
    console.log(
      `[db] updateIndexingState: updating existing record for ${r2Key}`
    );
    await db
      .updateTable("indexing_state")
      .set({
        etag,
        indexed_at: now,
        chunk_ids: chunkIdsJson,
      })
      .where("r2_key", "=", r2Key)
      .execute();
    console.log(`[db] updateIndexingState: update complete for ${r2Key}`);
  } else {
    console.log(`[db] updateIndexingState: inserting new record for ${r2Key}`);
    await db
      .insertInto("indexing_state")
      .values({
        r2_key: r2Key,
        etag,
        indexed_at: now,
        chunk_ids: chunkIdsJson,
        processed_chunk_hashes_json: "[]",
      })
      .execute();
    console.log(`[db] updateIndexingState: insert complete for ${r2Key}`);
  }
}

export async function getProcessedChunkHashes(
  r2Key: string
): Promise<string[]> {
  const db = createDb<IndexingStateDatabase>(
    (env as any)
      .ENGINE_INDEXING_STATE as DurableObjectNamespace<EngineIndexingStateDO>,
    "engine-indexing-state"
  );

  const result = await db
    .selectFrom("indexing_state")
    .select("processed_chunk_hashes_json")
    .where("r2_key", "=", r2Key)
    .executeTakeFirst();

  if (result?.processed_chunk_hashes_json) {
    // Kysely plugin auto-parses JSON fields, so this is already an array
    const hashes = result.processed_chunk_hashes_json;
    return Array.isArray(hashes) ? hashes : [];
  }

  return [];
}

export async function setProcessedChunkHashes(
  r2Key: string,
  chunkHashes: string[]
): Promise<void> {
  const db = createDb<IndexingStateDatabase>(
    (env as any)
      .ENGINE_INDEXING_STATE as DurableObjectNamespace<EngineIndexingStateDO>,
    "engine-indexing-state"
  );

  const now = new Date().toISOString();
  const hashesJson = JSON.stringify(chunkHashes);

  // Get the current etag from the indexing state, or use a placeholder if it doesn't exist
  const currentState = await db
    .selectFrom("indexing_state")
    .select("etag")
    .where("r2_key", "=", r2Key)
    .executeTakeFirst();

  const etag = currentState?.etag || "unknown";

  const result = await db
    .updateTable("indexing_state")
    .set({
      etag: etag,
      indexed_at: now,
      processed_chunk_hashes_json: hashesJson,
    })
    .where("r2_key", "=", r2Key)
    .executeTakeFirst();

  if (result.numUpdatedRows === 0n) {
    // If no row was updated, it means the r2_key doesn't exist yet. Insert it.
    await db
      .insertInto("indexing_state")
      .values({
        r2_key: r2Key,
        etag,
        indexed_at: now,
        chunk_ids: null as any,
        processed_chunk_hashes_json: hashesJson,
      })
      .execute();
  }
}

export async function clearAllIndexingState(): Promise<void> {
  throw new Error("clearAllIndexingState is not implemented for DO");
}

export { EngineIndexingStateDO } from "./durableObject";
export { indexingStateMigrations } from "./migrations";
