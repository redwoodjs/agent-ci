import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: `http://localhost:5173/auth/functions/`,
  fetchOptions: {
    headers: {
      "Access-Control-Allow-Origin":
        "https://p4p8.machinen.dev, http://localhost:5173",
      "Access-Control-Allow-Credentials": "true",
    },
  },
});

export const { signIn, signUp, signOut, useSession } = authClient;
