import { auth } from "./auth";
import { authClient } from "./auth-client";
import { route } from "rwsdk/router";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";

export const authRoutes = [
  route("/login", LoginPage),
  route("/register", RegisterPage),
  route("/logout", async function () {
    await authClient.signOut();
    return new Response(null, {
      status: 302,
      headers: { Location: "/auth/login" },
    });
  }),
  route("/functions/*", function ({ request }) {
    return auth.handler(request);
  }),
];
