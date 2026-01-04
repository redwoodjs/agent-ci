import { route } from "rwsdk/router";
import { codeOriginHandler } from "./code-origin";
import { requireQueryApiKey } from "@/app/engine/interruptors";

export const ghRoutes = [
  route("/api/gh/code-origin", {
    post: [requireQueryApiKey, codeOriginHandler],
  }),
];



