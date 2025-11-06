export interface GitHubProjectItem {
  id: string;
  content_id: number;
  content_type: "Issue" | "PullRequest" | "DraftIssue";
  project_node_id: string;
  field_values?: Array<{
    field_node_id: string;
    name: string;
    value: string | number | null;
  }>;
  created_at: string;
  updated_at: string;
}

export interface ProjectItemMetadata {
  github_id: string;
  project_github_id: string;
  content_id: number;
  content_type: "Issue" | "PullRequest" | "DraftIssue";
  state: "active" | "deleted";
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

export function projectItemToMarkdown(
  projectItem: GitHubProjectItem,
  metadata: ProjectItemMetadata
): string {
  const frontMatter = [
    `github_id: ${escapeYamlValue(metadata.github_id)}`,
    `project_github_id: ${escapeYamlValue(metadata.project_github_id)}`,
    `content_id: ${metadata.content_id}`,
    `content_type: ${escapeYamlValue(metadata.content_type)}`,
    `state: ${escapeYamlValue(metadata.state)}`,
    `created_at: ${escapeYamlValue(metadata.created_at)}`,
    `updated_at: ${escapeYamlValue(metadata.updated_at)}`,
    `version_hash: ${escapeYamlValue(metadata.version_hash)}`,
  ].join("\n");

  const fieldValues =
    projectItem.field_values && projectItem.field_values.length > 0
      ? projectItem.field_values
          .map((fv) => `- **${fv.name}**: ${fv.value ?? "null"}`)
          .join("\n")
      : "";

  return `---
${frontMatter}
---

# Project Item

**Content:** ${metadata.content_type} #${metadata.content_id}
${fieldValues ? `\n**Fields:**\n${fieldValues}\n` : ""}
`;
}

