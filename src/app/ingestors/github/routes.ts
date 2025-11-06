import { route } from "rwsdk/router";
import { type RequestInfo } from "rwsdk/worker";
import { requireGitHubWebhookSignature } from "./interruptors";

async function githubWebhookHandler({ request }: RequestInfo) {
  const payload = (await request.json()) as {
    repository?: { full_name?: string };
    [key: string]: unknown;
  };
  const event = request.headers.get("X-GitHub-Event");

  // TODO: Add logic to process the webhook event
  // For now, just log it.
  console.log(
    `Received GitHub webhook event: ${event} for ${payload.repository?.full_name}`
  );

  return new Response("Webhook received", { status: 202 });
}

export const routes = [
  route("/webhook", {
    post: [requireGitHubWebhookSignature, githubWebhookHandler],
  }),
];
