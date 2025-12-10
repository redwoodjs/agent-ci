import { env } from "cloudflare:workers";
import { CursorEventsDurableObject } from "../../ingestors/cursor/db/durableObject";
import { type Database, createDb } from "rwsdk/db";
import { type migrations } from "../../ingestors/cursor/db/migrations";

type CursorDatabase = Database<typeof migrations>;

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

  // Parse the JSON blob
  let cacheData: Record<string, { summary: string; embedding: number[] }> = {};
  if (typeof row.cache_json === "string") {
    cacheData = JSON.parse(row.cache_json);
  } else {
    cacheData = row.cache_json as Record<
      string,
      { summary: string; embedding: number[] }
    >;
  }

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
    if (typeof existing.cache_json === "string") {
      cacheData = JSON.parse(existing.cache_json);
    } else {
      cacheData = existing.cache_json as Record<
        string,
        { summary: string; embedding: number[] }
      >;
    }
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
