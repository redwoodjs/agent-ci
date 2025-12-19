import { processIssueEvent } from "./issue-processor";
import { processPullRequestEvent } from "./pr-processor";
import { processCommentEvent } from "./comment-processor";
import { processReleaseEvent } from "./release-processor";
import { processProjectEvent } from "./project-processor";
import { processProjectItemEvent } from "./project-item-processor";
import type { ProcessorJobMessage } from "./backfill-types";
import { incrementBackfillProcessedCountAndMaybeComplete } from "./backfill-state";
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
  const backfillRunId = message.backfill_run_id ?? null;
  const isBackfill = event_type === "backfill";
  const momentGraphNamespacePrefix =
    message.moment_graph_namespace_prefix ?? null;
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
    } for ${repository_key} (event: ${event_type}${
      isBackfill && backfillRunId ? ` runId=${backfillRunId}` : ""
    }${
      isBackfill && momentGraphNamespacePrefix
        ? ` prefix=${momentGraphNamespacePrefix}`
        : ""
    })`
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
        const comment = entity_data as GitHubComment & {
          issue_url?: string;
          pull_request_url?: string;
        };
        // Extract parent IDs from comment structure
        // Comments from webhooks have issue/pull_request objects with 'number' field
        // Comments from API have issue_url/pull_request_url fields instead
        let issueId = comment.issue?.number;
        let pullRequestId = comment.pull_request?.number;

        // If not found in nested objects, extract from URL fields (backfill scenario)
        if (!issueId && !pullRequestId) {
          if (comment.issue_url) {
            // Extract issue number from URL like: https://api.github.com/repos/owner/repo/issues/58
            const issueMatch = comment.issue_url.match(/\/issues\/(\d+)$/);
            if (issueMatch) {
              issueId = parseInt(issueMatch[1], 10);
              console.log(
                `[processor] Extracted issue ID ${issueId} from issue_url: ${comment.issue_url}`
              );
            }
          }
          if (comment.pull_request_url) {
            // Extract PR number from URL like: https://api.github.com/repos/owner/repo/pulls/58
            const prMatch = comment.pull_request_url.match(/\/pulls\/(\d+)$/);
            if (prMatch) {
              pullRequestId = parseInt(prMatch[1], 10);
              console.log(
                `[processor] Extracted PR ID ${pullRequestId} from pull_request_url: ${comment.pull_request_url}`
              );
            }
          }

          if (!issueId && !pullRequestId) {
            console.error(
              `[processor] Could not extract parent ID from comment:`,
              {
                commentId: comment.id,
                hasIssueUrl: !!comment.issue_url,
                hasPullRequestUrl: !!comment.pull_request_url,
                issueUrl: comment.issue_url,
                pullRequestUrl: comment.pull_request_url,
              }
            );
          }
        }

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

    if (isBackfill && backfillRunId) {
      const completion = await incrementBackfillProcessedCountAndMaybeComplete(
        repository_key,
        backfillRunId
      );
      if (completion?.shouldLogCompletion) {
        console.log("[backfill] processed completed", {
          repositoryKey: repository_key,
          backfillRunId,
          momentGraphNamespacePrefix: completion.momentGraphNamespacePrefix,
          processedCount: completion.processedCount,
          enqueuedCount: completion.enqueuedCount,
        });
      }
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
