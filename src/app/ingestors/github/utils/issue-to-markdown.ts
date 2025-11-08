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

export interface GitHubComment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
  user: {
    login: string;
    avatar_url?: string;
  };
}

export function issueToMarkdown(
  issue: GitHubIssue,
  metadata: IssueMetadata,
  comments?: GitHubComment[]
): string {
  const frontMatterLines = [
    `github_id: ${metadata.github_id}`,
    `number: ${metadata.number}`,
    `state: ${escapeYamlValue(metadata.state)}`,
    `author: ${escapeYamlValue(issue.user.login)}`,
    `created_at: ${escapeYamlValue(metadata.created_at)}`,
    `updated_at: ${escapeYamlValue(metadata.updated_at)}`,
    `version_hash: ${escapeYamlValue(metadata.version_hash)}`,
  ];

  if (issue.labels && issue.labels.length > 0) {
    const labelsList = issue.labels
      .map((label) => escapeYamlValue(label.name))
      .join(", ");
    frontMatterLines.push(`labels: [${labelsList}]`);
  }

  if (issue.assignees && issue.assignees.length > 0) {
    const assigneesList = issue.assignees
      .map((assignee) => escapeYamlValue(assignee.login))
      .join(", ");
    frontMatterLines.push(`assignees: [${assigneesList}]`);
  }

  if (issue.milestone) {
    frontMatterLines.push(
      `milestone: ${escapeYamlValue(issue.milestone.title)}`
    );
    frontMatterLines.push(
      `milestone_state: ${escapeYamlValue(issue.milestone.state)}`
    );
  }

  const frontMatter = frontMatterLines.join("\n");
  const body = issue.body || "_No description provided._";

  let commentsSection = "";
  if (comments && comments.length > 0) {
    const commentsText = comments
      .map(
        (comment) =>
          `---\n\n**Comment by @${comment.user.login}** (${comment.created_at})\n\n${comment.body}`
      )
      .join("\n\n");
    commentsSection = `\n\n---\n\n## Comments\n\n${commentsText}`;
  }

  return `---
${frontMatter}
---

# ${issue.title}

${body}${commentsSection}
`;
}
