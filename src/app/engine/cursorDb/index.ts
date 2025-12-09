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
  generationIds: string[]
): Promise<Map<string, { summary: string; embedding: number[] }>> {
  if (generationIds.length === 0) {
    return new Map();
  }

  const db = getCursorDb();
  const rows = await db
    .selectFrom("exchange_cache")
    .selectAll()
    .where("generation_id", "in", generationIds)
    .execute();

  const cache = new Map<string, { summary: string; embedding: number[] }>();
  for (const row of rows) {
    cache.set(row.generation_id, {
      summary: row.summary,
      embedding: JSON.parse(row.embedding) as number[],
    });
  }

  return cache;
}

export async function setExchangeCache(
  entries: Array<{ generationId: string; summary: string; embedding: number[] }>
): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  const db = getCursorDb();
  const now = new Date().toISOString();

  for (const entry of entries) {
    await db
      .insertInto("exchange_cache")
      .values({
        generation_id: entry.generationId,
        summary: entry.summary,
        embedding: JSON.stringify(entry.embedding),
        created_at: now,
      })
      .onConflict((oc) =>
        oc.column("generation_id").doUpdateSet({
          summary: entry.summary,
          embedding: JSON.stringify(entry.embedding),
          created_at: now,
        })
      )
      .execute();
  }
}
