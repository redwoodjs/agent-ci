import { route } from "rwsdk/router";
import { auth } from "@/lib/auth";

export const authRoutes = [
  // Handle all better-auth API routes
  route("/*", async ({ request }) => {
    return auth.handler(request);
  }),
];