import { processIssueEvent } from "./issue-processor";
import { processPullRequestEvent } from "./pr-processor";
import { processCommentEvent } from "./comment-processor";
import { processReleaseEvent } from "./release-processor";
import { processProjectEvent } from "./project-processor";
import { processProjectItemEvent } from "./project-item-processor";
import type { ProcessorJobMessage } from "./backfill-types";
import type { GitHubIssue } from "../utils/issue-to-markdown";
import type { GitHubPullRequest } from "../utils/pr-to-markdown";
import type { GitHubComment } from "../utils/comment-to-markdown";
import type { GitHubRelease } from "../utils/release-to-markdown";
import type { GitHubProject } from "../utils/project-to-markdown";
import type { GitHubProjectItem } from "../utils/project-item-to-markdown";

export async function processProcessorJob(
  message: ProcessorJobMessage
): Promise<void> {
  const { repository_key, owner, repo, entity_type, entity_data, event_type } =
    message;
  const repository = { owner: { login: owner }, name: repo };

  // Extract entity identifier for logging
  let entityId: string | number | undefined;
  if (entity_type === "issue") {
    entityId =
      (entity_data as GitHubIssue).number || (entity_data as GitHubIssue).id;
  } else if (entity_type === "pull_request") {
    entityId =
      (entity_data as GitHubPullRequest).number ||
      (entity_data as GitHubPullRequest).id;
  } else if (entity_type === "comment") {
    entityId = (entity_data as GitHubComment).id;
  } else if (entity_type === "release") {
    const release = entity_data as GitHubRelease;
    entityId = release.id || release.tag_name;
  } else if (entity_type === "project") {
    const project = entity_data as GitHubProject;
    entityId = project.id;
  } else if (entity_type === "project_item") {
    entityId = (entity_data as GitHubProjectItem).id;
  }

  console.log(
    `[processor] Processing ${entity_type} ${
      entityId ? `#${entityId}` : ""
    } for ${repository_key} (event: ${event_type})`
  );

  try {
    switch (entity_type) {
      case "issue": {
        const issue = entity_data as GitHubIssue;
        await processIssueEvent(
          issue,
          event_type === "backfill" ? "edited" : "opened",
          repository
        );
        console.log(
          `[processor] Completed processing issue #${entityId} for ${repository_key}`
        );
        break;
      }
      case "pull_request": {
        const pr = entity_data as GitHubPullRequest;
        await processPullRequestEvent(
          pr,
          event_type === "backfill" ? "edited" : "opened",
          repository
        );
        console.log(
          `[processor] Completed processing pull request #${entityId} for ${repository_key}`
        );
        break;
      }
      case "comment": {
        const comment = entity_data as GitHubComment;
        // Extract parent IDs from comment structure
        const issueId = comment.issue?.id || comment.issue?.number;
        const pullRequestId =
          comment.pull_request?.id || comment.pull_request?.number;
        const pullRequestReviewId = comment.pull_request_review_id;
        await processCommentEvent(
          comment,
          event_type === "backfill" ? "edited" : "created",
          repository,
          issueId,
          pullRequestId,
          pullRequestReviewId
        );
        console.log(
          `[processor] Completed processing comment ${entityId} for ${repository_key}`
        );
        break;
      }
      case "release": {
        const release = entity_data as GitHubRelease;
        await processReleaseEvent(
          release,
          event_type === "backfill" ? "edited" : "published",
          repository
        );
        console.log(
          `[processor] Completed processing release ${entityId} for ${repository_key}`
        );
        break;
      }
      case "project": {
        const project = entity_data as GitHubProject;
        await processProjectEvent(
          project,
          event_type === "backfill" ? "edited" : "created",
          repository
        );
        console.log(
          `[processor] Completed processing project ${entityId} for ${repository_key}`
        );
        break;
      }
      case "project_item": {
        const projectItem = entity_data as GitHubProjectItem;
        // Extract project ID from project item structure
        const projectId =
          projectItem.project_node_id || (projectItem as any).project_id;
        await processProjectItemEvent(
          projectItem,
          event_type === "backfill" ? "edited" : "created",
          repository,
          projectId
        );
        console.log(
          `[processor] Completed processing project item ${entityId} for ${repository_key}`
        );
        break;
      }
      default:
        throw new Error(`Unknown entity type: ${entity_type}`);
    }
  } catch (error) {
    console.error(
      `[processor] Error processing ${entity_type} ${
        entityId ? `#${entityId}` : ""
      } for ${repository_key}:`,
      error
    );
    throw error;
  }
}
