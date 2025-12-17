import { env } from "cloudflare:workers";
import { CursorEventsDurableObject } from "../../ingestors/cursor/db/durableObject";
import { type Database, createDb } from "rwsdk/db";
import { type migrations } from "../../ingestors/cursor/db/migrations";
import { Override } from "@/app/shared/kyselyTypeOverrides";

type CursorDatabase = Database<typeof migrations>;
type ExchangeCacheInput = CursorDatabase["exchange_cache"];
type ExchangeCache = Override<
  ExchangeCacheInput,
  {
    cache_json: Record<string, { summary: string; embedding: number[] }>;
  }
>;

function getCursorDb() {
  return createDb<CursorDatabase>(
    env.CURSOR_EVENTS as DurableObjectNamespace<CursorEventsDurableObject>,
    "cursor-events"
  );
}

export async function getExchangeCache(
  documentId: string
): Promise<Map<string, { summary: string; embedding: number[] }>> {
  const db = getCursorDb();
  const row = await db
    .selectFrom("exchange_cache")
    .selectAll()
    .where("document_id", "=", documentId)
    .executeTakeFirst();

  if (!row) {
    return new Map();
  }

  const cacheData = (row as unknown as ExchangeCache).cache_json;

  // Convert to Map
  const cache = new Map<string, { summary: string; embedding: number[] }>();
  for (const [generationId, entry] of Object.entries(cacheData)) {
    cache.set(generationId, entry);
  }

  return cache;
}

export async function setExchangeCache(
  documentId: string,
  entries: Array<{ generationId: string; summary: string; embedding: number[] }>
): Promise<void> {
  const db = getCursorDb();
  const now = new Date().toISOString();

  // Get existing cache
  const existing = await db
    .selectFrom("exchange_cache")
    .selectAll()
    .where("document_id", "=", documentId)
    .executeTakeFirst();

  let cacheData: Record<string, { summary: string; embedding: number[] }> = {};
  if (existing) {
    cacheData = (existing as unknown as ExchangeCache).cache_json;
  }

  // Merge new entries into cache
  for (const entry of entries) {
    cacheData[entry.generationId] = {
      summary: entry.summary,
      embedding: entry.embedding,
    };
  }

  // Write entire blob back
  const cacheJson = JSON.stringify(cacheData);
  await db
    .insertInto("exchange_cache")
    .values({
      document_id: documentId,
      cache_json: cacheJson,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.column("document_id").doUpdateSet({
        cache_json: cacheJson,
        updated_at: now,
      })
    )
    .execute();
}

// TEMPORARY: Testing function to clear exchange cache
export async function clearExchangeCache(): Promise<void> {
  const db = getCursorDb();
  await db.deleteFrom("exchange_cache").execute();
  console.log("[cursorDb] Cleared all exchange cache (testing)");
}
