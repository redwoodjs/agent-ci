import { route } from "rwsdk/router";
import { type RequestInfo } from "rwsdk/worker";
import { requireGitHubWebhookSignature } from "./interruptors";
import { processIssueEvent } from "./services/issue-processor";
import type { GitHubIssue } from "./utils/issue-to-markdown";

interface GitHubWebhookPayload {
  action: string;
  issue?: GitHubIssue;
  repository?: {
    owner: { login: string };
    name: string;
    full_name?: string;
  };
  [key: string]: unknown;
}

async function githubWebhookHandler({ request }: RequestInfo) {
  const payload = (await request.json()) as GitHubWebhookPayload;
  const event = request.headers.get("X-GitHub-Event");

  if (!event) {
    return Response.json(
      { error: "Missing X-GitHub-Event header" },
      { status: 400 }
    );
  }

  if (!payload.repository) {
    return Response.json(
      { error: "Missing repository in payload" },
      { status: 400 }
    );
  }

  if (event === "issues") {
    const { action, issue, repository } = payload;

    if (!issue || !repository) {
      return Response.json(
        { error: "Missing issue or repository in payload" },
        { status: 400 }
      );
    }

    if (
      action === "opened" ||
      action === "edited" ||
      action === "closed" ||
      action === "reopened" ||
      action === "deleted"
    ) {
      try {
        await processIssueEvent(issue, action, repository);
        return new Response("Issue processed", { status: 202 });
      } catch (error) {
        console.error("[github ingest] Error processing issue:", error);
        return Response.json(
          { error: "Failed to process issue" },
          { status: 500 }
        );
      }
    }

    return new Response("Issue event action not handled", { status: 202 });
  }

  return new Response("Event type not handled", { status: 202 });
}

export const routes = [
  route("/webhook", {
    post: [requireGitHubWebhookSignature, githubWebhookHandler],
  }),
];
