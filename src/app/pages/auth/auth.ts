import { betterAuth } from "better-auth";
import { rwsdkAdapter } from "./adapter";

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET || "fallback-development-secret",
  baseURL: "http://localhost:5173/auth/functions/",

  database: rwsdkAdapter({
    debugLogs: false,
    usePlural: false,
  }),

  emailAndPassword: {
    enabled: true,
  },
});
