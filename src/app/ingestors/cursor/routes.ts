import { route } from "rwsdk/router";
import { env } from "cloudflare:workers";
import { type RequestInfo } from "rwsdk/worker";
import debug from "rwsdk/debug";
import { type Database, createDb } from "rwsdk/db";
import { type migrations } from "./db/migrations";
import { type CursorEventsDurableObject } from "./db/durableObject";
import { requireApiKey } from "./interruptors";

const log = debug("machinen:cursor:ingest");

type CursorDatabase = Database<typeof migrations>;

declare module "rwsdk/worker" {
  interface WorkerEnv {
    CURSOR_EVENTS: DurableObjectNamespace<CursorEventsDurableObject>;
  }
}

export interface CursorEvent {
  conversation_id: string;
  generation_id: string;
  hook_event_name: string;
  [key: string]: any;
}

async function ingestHandler({ request, ctx }: RequestInfo) {
  const data = (await request.json()) as CursorEvent;
  const { conversation_id, generation_id, hook_event_name } = data;

  if (!generation_id) {
    log("Missing generation_id", data);
    return Response.json({ error: "Missing generation_id" }, { status: 400 });
  }

  if (!conversation_id) {
    log("Missing conversation_id", data);
    return Response.json({ error: "Missing conversation_id" }, { status: 400 });
  }

  const db = createDb<CursorDatabase>(env.CURSOR_EVENTS, conversation_id);

  await db
    .insertInto("events")
    .values({
      id: crypto.randomUUID(),
      event_data: JSON.stringify(data),
      timestamp: new Date().toISOString(),
    })
    .execute();

  if (hook_event_name === "stop") {
    const eventsResult = await db
      .selectFrom("events")
      .selectAll()
      .orderBy("timestamp", "asc")
      .execute();

    const allEvents = eventsResult.map((row) => {
      let eventData: CursorEvent;
      if (typeof row.event_data === "string") {
        eventData = JSON.parse(row.event_data) as CursorEvent;
      } else {
        eventData = row.event_data as CursorEvent;
      }
      return {
        rowId: row.id,
        data: eventData,
      };
    });

    // Filter for the current generation
    const generationEvents = allEvents
      .filter((e) => e.data.generation_id === generation_id)
      .map((e) => e.data);

    if (generationEvents.length > 0) {
      const key = `cursor/conversations/${conversation_id}/latest.json`;

      let conversationData = {
        id: conversation_id,
        generations: [] as { id: string; events: CursorEvent[] }[],
      };

      const existing = await env.MACHINEN_BUCKET.get(key);
      if (existing) {
        try {
          const text = await existing.text();
          conversationData = JSON.parse(text);
        } catch (e) {
          log("Error parsing existing conversation data", { error: e, key });
          // If corrupt, start fresh but preserve ID
          conversationData = {
            id: conversation_id,
            generations: [],
          };
        }
      }

      // Append new generation
      conversationData.generations.push({
        id: generation_id,
        events: generationEvents,
      });

      log("[cursor ingest] Storing conversation update to R2", {
        key,
        generationsCount: conversationData.generations.length,
      });

      await env.MACHINEN_BUCKET.put(
        key,
        JSON.stringify(conversationData, null, 2)
      );

      // Delete processed events
      const idsToDelete = allEvents
        .filter((e) => e.data.generation_id === generation_id)
        .map((e) => e.rowId);

      if (idsToDelete.length > 0) {
        await db.deleteFrom("events").where("id", "in", idsToDelete).execute();
      }
    }
  }

  return Response.json({ success: true });
}

export const routes = [
  route("/", {
    post: [requireApiKey, ingestHandler],
  }),
];
