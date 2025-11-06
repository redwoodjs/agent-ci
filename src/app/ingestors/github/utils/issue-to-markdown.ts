export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  created_at: string;
  updated_at: string;
  user: {
    login: string;
    avatar_url?: string;
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

export interface IssueMetadata {
  github_id: number;
  number: number;
  state: "open" | "closed" | "deleted";
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

export function issueToMarkdown(
  issue: GitHubIssue,
  metadata: IssueMetadata
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
    issue.labels && issue.labels.length > 0
      ? issue.labels.map((label) => `- ${label.name}`).join("\n")
      : "";

  const assignees =
    issue.assignees && issue.assignees.length > 0
      ? issue.assignees.map((assignee) => `- @${assignee.login}`).join("\n")
      : "";

  const milestone = issue.milestone
    ? `**Milestone:** ${issue.milestone.title} (${issue.milestone.state})`
    : "";

  const metadataSection = [labels, assignees, milestone]
    .filter(Boolean)
    .join("\n\n");

  const body = issue.body || "_No description provided._";

  return `---
${frontMatter}
---

# ${issue.title}

**Author:** @${issue.user.login}
${metadataSection ? `\n${metadataSection}\n` : ""}

---

${body}
`;
}
