import { processIssueEvent } from "./issue-processor";
import { processPullRequestEvent } from "./pr-processor";
import { processCommentEvent } from "./comment-processor";
import { processReleaseEvent } from "./release-processor";
import { processProjectEvent } from "./project-processor";
import type { ProcessorJobMessage } from "./backfill-types";
import type { GitHubIssue } from "../utils/issue-to-markdown";
import type { GitHubPullRequest } from "../utils/pr-to-markdown";
import type { GitHubComment } from "../utils/comment-to-markdown";
import type { GitHubRelease } from "../utils/release-to-markdown";
import type { GitHubProject } from "../utils/project-to-markdown";
import type { GitHubProjectItem } from "../utils/project-item-to-markdown";

export async function processProcessorJob(message: ProcessorJobMessage): Promise<void> {
  const { repository_key, owner, repo, entity_type, entity_data, event_type } = message;
  const repository = { owner: { login: owner }, name: repo };

  try {
    switch (entity_type) {
      case "issue": {
        const issue = entity_data as GitHubIssue;
        await processIssueEvent(issue, "opened", repository);
        break;
      }
      case "pull_request": {
        const pr = entity_data as GitHubPullRequest;
        await processPullRequestEvent(pr, "opened", repository);
        break;
      }
      case "comment": {
        const comment = entity_data as GitHubComment;
        await processCommentEvent(comment, "created", repository);
        break;
      }
      case "release": {
        const release = entity_data as GitHubRelease;
        await processReleaseEvent(release, "published", repository);
        break;
      }
      case "project": {
        const project = entity_data as GitHubProject;
        await processProjectEvent(project, "created", repository);
        break;
      }
      default:
        throw new Error(`Unknown entity type: ${entity_type}`);
    }
  } catch (error) {
    console.error(
      `[processor] Error processing ${entity_type} for ${repository_key}:`,
      error
    );
    throw error;
  }
}

