import type { GitHubIssue, GitHubComment } from "./issue-to-markdown";
import type { IssueMetadata } from "./issue-to-markdown";

export interface IssueLatestJson {
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

export function issueToJson(
  issue: GitHubIssue,
  metadata: IssueMetadata,
  comments?: GitHubComment[],
  url?: string
): IssueLatestJson {
  const json: IssueLatestJson = {
    github_id: metadata.github_id,
    number: metadata.number,
    state: metadata.state,
    author: issue.user.login,
    created_at: metadata.created_at,
    updated_at: metadata.updated_at,
    title: issue.title,
    body: issue.body || "",
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

