import { route } from "rwsdk/router";
import { requireIngestApiKey } from "../interruptors";
import { agentConversationHandler } from "./conversation";

export const agentRoutes = [
  route("/api/ingestors/agent/conversation", {
    post: [requireIngestApiKey, agentConversationHandler],
  }),
];
