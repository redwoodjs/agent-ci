import { type Context, Hono } from 'rwsdk/http';

const routes = new Hono();

routes.post('/', async (c: Context) => {
  const bucket = c.env.MACHINEN_BUCKET;
  const data = await c.req.json();
  const { conversation_id, hook_event_name } = data;

  if (!conversation_id || !hook_event_name) {
    return c.json({ error: 'Missing conversation_id or hook_event_name' }, 400);
  }

  const key = `cursor-conversations/${conversation_id}/${Date.now()}-${hook_event_name}.json`;

  await bucket.put(key, JSON.stringify(data, null, 2));

  return c.json({ success: true });
});

export { routes };
