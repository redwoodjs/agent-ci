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

  // Enable social providers if needed
  // socialProviders: {
  //   github: {
  //     clientId: process.env.GITHUB_CLIENT_ID as string,
  //     clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
  //   },
  // },
});
