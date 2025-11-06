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
  const frontMatter = [
    `github_id: ${metadata.github_id}`,
    `number: ${metadata.number}`,
    `state: ${escapeYamlValue(metadata.state)}`,
    `created_at: ${escapeYamlValue(metadata.created_at)}`,
    `updated_at: ${escapeYamlValue(metadata.updated_at)}`,
    `version_hash: ${escapeYamlValue(metadata.version_hash)}`,
  ].join("\n");

  const labels =
    pr.labels && pr.labels.length > 0
      ? pr.labels.map((label) => `- ${label.name}`).join("\n")
      : "";

  const assignees =
    pr.assignees && pr.assignees.length > 0
      ? pr.assignees.map((assignee) => `- @${assignee.login}`).join("\n")
      : "";

  const milestone = pr.milestone
    ? `**Milestone:** ${pr.milestone.title} (${pr.milestone.state})`
    : "";

  const branches = `**Base:** ${pr.base.ref} (${pr.base.sha.substring(0, 7)})\n**Head:** ${pr.head.ref} (${pr.head.sha.substring(0, 7)})`;

  const metadataSection = [labels, assignees, milestone, branches]
    .filter(Boolean)
    .join("\n\n");

  const body = pr.body || "_No description provided._";

  return `---
${frontMatter}
---

# ${pr.title}

**Author:** @${pr.user.login}
${metadataSection ? `\n${metadataSection}\n` : ""}

---

${body}
`;
}

