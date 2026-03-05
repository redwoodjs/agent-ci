// --GROK--: Stub worker for teardown deploy. Only purpose is to carry the v15 deletion migration
// that removes all Durable Object classes. Will be deleted after migration runs.
export default {
  async fetch() {
    return new Response("shutting down", { status: 503 });
  },
} satisfies ExportedHandler;
