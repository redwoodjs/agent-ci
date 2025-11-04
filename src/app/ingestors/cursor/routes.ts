import { route } from "rwsdk/router";
import { env } from "cloudflare:workers";
import { type RequestInfo } from "rwsdk/worker";
import debug from "rwsdk/debug";
import { type CursorEventsDurableObject } from "./db/durableObject";

const log = debug("machinen:cursor:ingest");

declare module "rwsdk/worker" {
  interface WorkerEnv {
    CURSOR_EVENTS: DurableObjectNamespace<CursorEventsDurableObject>;
  }
}

async function ingestHandler({ request, ctx }: RequestInfo) {
  const data = (await request.json()) as CursorEvent;

  const { generation_id, hook_event_name } = data;

  if (!generation_id) {
    log("Missing generation_id", data);
    return Response.json({ error: "Missing generation_id" }, { status: 400 });
  }

  const id = env.CURSOR_EVENTS.idFromString(generation_id);
  const stub = env.CURSOR_EVENTS.get(id);

  await stub.addEvent(data);

  if (hook_event_name === "stop") {
    await stub.finalize(env.MACHINEN_BUCKET);
  }

  return Response.json({ success: true });
}

export const routes = [
  route("/", {
    post: ingestHandler,
  }),
];
