import { route } from "rwsdk/router";
import { env } from "cloudflare:workers";
import { type RequestInfo } from "rwsdk/worker";
import debug from "rwsdk/debug";
import { type Database, createDb } from "rwsdk/db";
import { type migrations } from "./db/migrations";
import { type CursorEventsDurableObject } from "./db/durableObject";

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
  const { generation_id, hook_event_name } = data;

  if (!generation_id) {
    log("Missing generation_id", data);
    return Response.json({ error: "Missing generation_id" }, { status: 400 });
  }

  const db = createDb<CursorDatabase>(env.CURSOR_EVENTS, generation_id);

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

    if (eventsResult.length > 0) {
      const events: CursorEvent[] = eventsResult.map((row) =>
        JSON.parse(row.event_data)
      );
      const { conversation_id } = events[0];
      const key = `cursor-conversations-v2/${conversation_id}/${generation_id}.json`;

      const aggregatedData = {
        conversation_id,
        generation_id,
        events,
      };

      await env.MACHINEN_BUCKET.put(
        key,
        JSON.stringify(aggregatedData, null, 2)
      );
      await db.deleteFrom("events").execute();
    }
  }

  return Response.json({ success: true });
}

export const routes = [
  route("/", {
    post: ingestHandler,
  }),
];
