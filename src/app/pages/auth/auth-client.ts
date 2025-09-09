import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: "http://localhost:5173/auth/functions/",
});

export const { signIn, signUp, signOut, useSession } = authClient;
