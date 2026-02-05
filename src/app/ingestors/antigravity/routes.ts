import { route } from "rwsdk/router";
import { requireIngestApiKey } from "../interruptors";
import { antigravityConversationHandler } from "./conversation";

export const antigravityRoutes = [
  route("/api/ingestors/antigravity/conversation", {
    post: [requireIngestApiKey, antigravityConversationHandler],
  }),
];
