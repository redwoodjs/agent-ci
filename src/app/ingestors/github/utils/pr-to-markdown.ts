export interface GitHubPullRequest {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  merged: boolean;
  created_at: string;
  updated_at: string;
  user: {
    login: string;
    avatar_url?: string;
  };
  base: {
    ref: string;
    sha: string;
  };
  head: {
    ref: string;
    sha: string;
  };
  labels?: Array<{
    name: string;
    color?: string;
  }>;
  assignees?: Array<{
    login: string;
    avatar_url?: string;
  }>;
  milestone?: {
    title: string;
    state: string;
  };
}

export interface PullRequestMetadata {
  github_id: number;
  number: number;
  state: "open" | "closed" | "merged" | "deleted";
  created_at: string;
  updated_at: string;
  version_hash: string;
}

function escapeYamlValue(value: string | number | boolean): string {
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

export function prToMarkdown(
  pr: GitHubPullRequest,
  metadata: PullRequestMetadata
): string {
  const frontMatterLines = [
    `github_id: ${metadata.github_id}`,
    `number: ${metadata.number}`,
    `state: ${escapeYamlValue(metadata.state)}`,
    `author: ${escapeYamlValue(pr.user.login)}`,
    `created_at: ${escapeYamlValue(metadata.created_at)}`,
    `updated_at: ${escapeYamlValue(metadata.updated_at)}`,
    `version_hash: ${escapeYamlValue(metadata.version_hash)}`,
    `base_ref: ${escapeYamlValue(pr.base.ref)}`,
    `base_sha: ${escapeYamlValue(pr.base.sha)}`,
    `head_ref: ${escapeYamlValue(pr.head.ref)}`,
    `head_sha: ${escapeYamlValue(pr.head.sha)}`,
  ];

  if (pr.labels && pr.labels.length > 0) {
    const labelsList = pr.labels.map((label) => escapeYamlValue(label.name)).join(", ");
    frontMatterLines.push(`labels: [${labelsList}]`);
  }

  if (pr.assignees && pr.assignees.length > 0) {
    const assigneesList = pr.assignees.map((assignee) => escapeYamlValue(assignee.login)).join(", ");
    frontMatterLines.push(`assignees: [${assigneesList}]`);
  }

  if (pr.milestone) {
    frontMatterLines.push(`milestone: ${escapeYamlValue(pr.milestone.title)}`);
    frontMatterLines.push(`milestone_state: ${escapeYamlValue(pr.milestone.state)}`);
  }

  const frontMatter = frontMatterLines.join("\n");
  const body = pr.body || "_No description provided._";

  return `---
${frontMatter}
---

# ${pr.title}

${body}
`;
}

