import { route } from "rwsdk/router";
import { env } from "cloudflare:workers";
import { type RequestInfo } from "rwsdk/worker";
import debug from "rwsdk/debug";

const log = debug("cursor:ingest");

async function ingestHandler({ request, ctx }: RequestInfo) {
  const bucket = env.MACHINEN_BUCKET;
  const data = await request.json();
  const { conversation_id, hook_event_name } = data as {
    conversation_id: string;
    hook_event_name: string;
  };

  if (!conversation_id || !hook_event_name) {
    log("Missing conversation_id or hook_event_name", data);
    return Response.json(
      { error: "Missing conversation_id or hook_event_name" },
      { status: 400 }
    );
  }

  const key = `cursor-conversations/${conversation_id}/${Date.now()}-${hook_event_name}.json`;

  log("Storing cursor conversation event", {
    conversation_id,
    hook_event_name,
    key,
  });

  await bucket.put(key, JSON.stringify(data, null, 2));

  return Response.json({ success: true });
}

export const routes = [
  route("/", {
    post: ingestHandler,
  }),
];
