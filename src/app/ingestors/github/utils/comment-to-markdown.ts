export interface GitHubComment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
  user: {
    login: string;
    avatar_url?: string;
  };
  issue?: {
    number: number;
  };
  pull_request?: {
    number: number;
  };
  pull_request_review_id?: number;
}

export interface CommentMetadata {
  github_id: number;
  issue_id?: number;
  pull_request_id?: number;
  review_id?: number;
  created_at: string;
  updated_at: string;
  version_hash: string;
}

function escapeYamlValue(value: string | number | boolean | undefined): string {
  if (value === undefined || value === null) {
    return "";
  }
  const str = String(value);
  if (
    str.includes(":") ||
    str.includes("\n") ||
    str.includes('"') ||
    str.startsWith(" ") ||
    str.endsWith(" ")
  ) {
    return `"${str.replace(/"/g, '\\"')}"`;
  }
  return str;
}

export function commentToMarkdown(
  comment: GitHubComment,
  metadata: CommentMetadata
): string {
  const frontMatterLines = [
    `github_id: ${metadata.github_id}`,
    `author: ${escapeYamlValue(comment.user.login)}`,
  ];

  if (metadata.issue_id) {
    frontMatterLines.push(`issue_id: ${metadata.issue_id}`);
  }
  if (metadata.pull_request_id) {
    frontMatterLines.push(`pull_request_id: ${metadata.pull_request_id}`);
  }
  if (metadata.review_id) {
    frontMatterLines.push(`review_id: ${metadata.review_id}`);
  }

  frontMatterLines.push(
    `created_at: ${escapeYamlValue(metadata.created_at)}`,
    `updated_at: ${escapeYamlValue(metadata.updated_at)}`,
    `version_hash: ${escapeYamlValue(metadata.version_hash)}`
  );

  const frontMatter = frontMatterLines.join("\n");

  return `---
${frontMatter}
---

${comment.body}
`;
}

