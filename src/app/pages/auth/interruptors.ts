import type { RequestInfo } from "rwsdk/worker";

export async function requireAuth({ ctx }: RequestInfo) {
  if (!ctx.user) {
    return new Response(null, {
      status: 302,
      headers: { Location: "/auth/login" },
    });
  }
}
