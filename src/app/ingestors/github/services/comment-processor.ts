import { type GitHubComment } from "../utils/comment-to-markdown";
import { processIssueEvent } from "./issue-processor";
import { processPullRequestEvent } from "./pr-processor";
import type { GitHubIssue } from "../utils/issue-to-markdown";
import type { GitHubPullRequest } from "../utils/pr-to-markdown";

export async function processCommentEvent(
  partialComment: GitHubComment,
  eventType: "created" | "edited" | "deleted",
  repository: { owner: { login: string }; name: string },
  issueId?: number,
  pullRequestId?: number,
  reviewId?: number
): Promise<void> {
  const parentNumber = issueId || pullRequestId;
  if (!parentNumber) {
    throw new Error(
      `Comment ${partialComment.id} has no parent issue or pull request`
    );
  }

  if (issueId) {
    const partialIssue: GitHubIssue = {
      id: 0,
      number: issueId,
      title: "",
      body: null,
      state: "open",
      created_at: "",
      updated_at: "",
      user: { login: "" },
    };
    await processIssueEvent(partialIssue, "edited", repository);
  } else if (pullRequestId) {
    const partialPR: GitHubPullRequest = {
      id: 0,
      number: pullRequestId,
      title: "",
      body: null,
      state: "open",
      merged: false,
      created_at: "",
      updated_at: "",
      user: { login: "" },
      base: { ref: "", sha: "" },
      head: { ref: "", sha: "" },
    };
    await processPullRequestEvent(partialPR, "edited", repository);
  }
}
