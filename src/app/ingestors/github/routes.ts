import { route } from "rwsdk/router";
import { type RequestInfo } from "rwsdk/worker";
import { requireGitHubWebhookSignature } from "./interruptors";
import { processIssueEvent } from "./services/issue-processor";
import { processPullRequestEvent } from "./services/pr-processor";
import { processCommentEvent } from "./services/comment-processor";
import { processReleaseEvent } from "./services/release-processor";
import { processProjectEvent } from "./services/project-processor";
import { processProjectItemEvent } from "./services/project-item-processor";
import type { GitHubIssue } from "./utils/issue-to-markdown";
import type { GitHubPullRequest } from "./utils/pr-to-markdown";
import type { GitHubComment } from "./utils/comment-to-markdown";
import type { GitHubRelease } from "./utils/release-to-markdown";
import type { GitHubProject } from "./utils/project-to-markdown";
import type { GitHubProjectItem } from "./utils/project-item-to-markdown";

interface GitHubWebhookPayload {
  action: string;
  issue?: GitHubIssue | { id?: number; number?: number };
  pull_request?: GitHubPullRequest | { id?: number; number?: number };
  comment?: GitHubComment;
  release?: GitHubRelease;
  project?: GitHubProject;
  projects_v2_item?: GitHubProjectItem;
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

  if (event === "pull_request") {
    const { action, pull_request, repository } = payload;

    if (!pull_request || !repository) {
      return Response.json(
        { error: "Missing pull_request or repository in payload" },
        { status: 400 }
      );
    }

    if (
      action === "opened" ||
      action === "edited" ||
      action === "closed" ||
      action === "reopened" ||
      action === "merged" ||
      action === "synchronize" ||
      action === "deleted"
    ) {
      try {
        await processPullRequestEvent(pull_request, action, repository);
        return new Response("Pull request processed", { status: 202 });
      } catch (error) {
        console.error("[github ingest] Error processing pull request:", error);
        return Response.json(
          { error: "Failed to process pull request" },
          { status: 500 }
        );
      }
    }

    return new Response("Pull request event action not handled", { status: 202 });
  }

  if (event === "issue_comment") {
    const { action, comment, issue, repository } = payload;

    if (!comment || !repository) {
      return Response.json(
        { error: "Missing comment or repository in payload" },
        { status: 400 }
      );
    }

    if (action === "created" || action === "edited" || action === "deleted") {
      try {
        const issueId = (issue as GitHubIssue)?.id || (issue as { id?: number })?.id;
        await processCommentEvent(comment, action, repository, issueId);
        return new Response("Comment processed", { status: 202 });
      } catch (error) {
        console.error("[github ingest] Error processing comment:", error);
        return Response.json(
          { error: "Failed to process comment" },
          { status: 500 }
        );
      }
    }

    return new Response("Comment event action not handled", { status: 202 });
  }

  if (event === "pull_request_review_comment") {
    const { action, comment, pull_request, repository } = payload;

    if (!comment || !repository) {
      return Response.json(
        { error: "Missing comment or repository in payload" },
        { status: 400 }
      );
    }

    if (action === "created" || action === "edited" || action === "deleted") {
      try {
        const pullRequestId = (pull_request as GitHubPullRequest)?.id || (pull_request as { id?: number })?.id;
        const reviewId = comment.pull_request_review_id;
        await processCommentEvent(
          comment,
          action,
          repository,
          undefined,
          pullRequestId,
          reviewId
        );
        return new Response("Review comment processed", { status: 202 });
      } catch (error) {
        console.error("[github ingest] Error processing review comment:", error);
        return Response.json(
          { error: "Failed to process review comment" },
          { status: 500 }
        );
      }
    }

    return new Response("Review comment event action not handled", { status: 202 });
  }

  if (event === "release") {
    const { action, release, repository } = payload;

    if (!release || !repository) {
      return Response.json(
        { error: "Missing release or repository in payload" },
        { status: 400 }
      );
    }

    if (
      action === "published" ||
      action === "edited" ||
      action === "deleted" ||
      action === "prereleased" ||
      action === "released"
    ) {
      try {
        await processReleaseEvent(release, action, repository);
        return new Response("Release processed", { status: 202 });
      } catch (error) {
        console.error("[github ingest] Error processing release:", error);
        return Response.json(
          { error: "Failed to process release" },
          { status: 500 }
        );
      }
    }

    return new Response("Release event action not handled", { status: 202 });
  }

  if (event === "projects_v2") {
    const { action, project, repository } = payload;

    if (!project || !repository) {
      return Response.json(
        { error: "Missing project or repository in payload" },
        { status: 400 }
      );
    }

    if (
      action === "created" ||
      action === "edited" ||
      action === "closed" ||
      action === "reopened" ||
      action === "deleted"
    ) {
      try {
        await processProjectEvent(project, action, repository);
        return new Response("Project processed", { status: 202 });
      } catch (error) {
        console.error("[github ingest] Error processing project:", error);
        return Response.json(
          { error: "Failed to process project" },
          { status: 500 }
        );
      }
    }

    return new Response("Project event action not handled", { status: 202 });
  }

  if (event === "projects_v2_item") {
    const { action, projects_v2_item, project, repository } = payload;

    if (!projects_v2_item || !repository) {
      return Response.json(
        { error: "Missing projects_v2_item or repository in payload" },
        { status: 400 }
      );
    }

    const projectId = project?.id || projects_v2_item.project_node_id;
    if (!projectId) {
      return Response.json(
        { error: "Missing project ID in payload" },
        { status: 400 }
      );
    }

    if (action === "created" || action === "edited" || action === "deleted") {
      try {
        await processProjectItemEvent(
          projects_v2_item,
          action,
          repository,
          projectId
        );
        return new Response("Project item processed", { status: 202 });
      } catch (error) {
        console.error("[github ingest] Error processing project item:", error);
        return Response.json(
          { error: "Failed to process project item" },
          { status: 500 }
        );
      }
    }

    return new Response("Project item event action not handled", { status: 202 });
  }

  return new Response("Event type not handled", { status: 202 });
}

export const routes = [
  route("/webhook", {
    post: [requireGitHubWebhookSignature, githubWebhookHandler],
  }),
];
