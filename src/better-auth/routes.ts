import { auth } from "./auth";
import { route } from "rwsdk/router";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";

export const betterAuthRoutes = [
  route("/login", LoginPage),
  route("/register", RegisterPage),
  route("/functions/*", function ({ request }) {
    return auth.handler(request);
  }),
];
