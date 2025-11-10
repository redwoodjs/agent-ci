import type { GitHubPullRequest, GitHubComment } from "./pr-to-markdown";
import type { PullRequestMetadata } from "./pr-to-markdown";

export interface PRLatestJson {
  github_id: number;
  number: number;
  state: string;
  author: string;
  created_at: string;
  updated_at: string;
  title: string;
  body: string;
  comments?: Array<{
    id: number;
    body: string;
    author: string;
    created_at: string;
    updated_at?: string;
  }>;
  url?: string;
  [key: string]: unknown;
}

export function prToJson(
  pr: GitHubPullRequest,
  metadata: PullRequestMetadata,
  comments?: GitHubComment[],
  url?: string
): PRLatestJson {
  const json: PRLatestJson = {
    github_id: metadata.github_id,
    number: metadata.number,
    state: metadata.state,
    author: pr.user.login,
    created_at: metadata.created_at,
    updated_at: metadata.updated_at,
    title: pr.title,
    body: pr.body || "",
  };

  if (url) {
    json.url = url;
  }

  if (comments && comments.length > 0) {
    json.comments = comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      author: comment.user.login,
      created_at: comment.created_at,
      updated_at: comment.updated_at,
    }));
  }

  return json;
}
