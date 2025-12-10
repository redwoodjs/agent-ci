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
    // rwsdk/db auto-parses JSON columns, so embedding should already be an array
    let embedding: number[];
    if (Array.isArray(row.embedding)) {
      embedding = row.embedding;
    } else if (typeof row.embedding === "string") {
      // Fallback: parse if it's still a string (shouldn't happen with auto-parsing)
      console.warn(
        `[cursorDb] Embedding is still a string, parsing manually. This shouldn't happen if auto-parsing is working.`
      );
      embedding = JSON.parse(row.embedding) as number[];
    } else {
      console.error(
        `[cursorDb] Unexpected embedding type: ${typeof row.embedding}, value: ${JSON.stringify(
          row.embedding
        ).substring(0, 100)}`
      );
      continue;
    }
    cache.set(row.generation_id, {
      summary: row.summary,
      embedding,
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

// TEMPORARY: Testing function to clear exchange cache
export async function clearExchangeCache(): Promise<void> {
  const db = getCursorDb();
  await db.deleteFrom("exchange_cache").execute();
  console.log("[cursorDb] Cleared all exchange cache (testing)");
}
