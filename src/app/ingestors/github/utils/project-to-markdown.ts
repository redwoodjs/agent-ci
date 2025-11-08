export interface GitHubProject {
  id: string;
  number?: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  created_at: string;
  updated_at: string;
  owner: {
    login: string;
    type: string;
  };
}

export interface ProjectMetadata {
  github_id: string;
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

export interface ProjectItemWithTitle {
  id: string;
  content_id?: number;
  content_type: "Issue" | "PullRequest" | "DraftIssue";
  title?: string;
  field_values?: Array<{
    name: string;
    value: string | number | null;
  }>;
}

export function projectToMarkdown(
  project: GitHubProject,
  metadata: ProjectMetadata,
  items?: ProjectItemWithTitle[]
): string {
  const frontMatterLines = [
    `github_id: ${escapeYamlValue(metadata.github_id)}`,
  ];

  if (project.number) {
    frontMatterLines.push(`number: ${project.number}`);
  }

  frontMatterLines.push(
    `state: ${escapeYamlValue(metadata.state)}`,
    `owner: ${escapeYamlValue(project.owner.login)}`,
    `owner_type: ${escapeYamlValue(project.owner.type)}`,
    `created_at: ${escapeYamlValue(metadata.created_at)}`,
    `updated_at: ${escapeYamlValue(metadata.updated_at)}`,
    `version_hash: ${escapeYamlValue(metadata.version_hash)}`
  );

  const frontMatter = frontMatterLines.join("\n");
  const body = project.body || "_No description provided._";

  let itemsSection = "";
  if (items && items.length > 0) {
    const itemsText = items
      .map((item) => {
        const statusField = item.field_values?.find((fv) =>
          ["Status", "State", "Column"].includes(fv.name)
        );
        const status = statusField ? `[${statusField.value}]` : "";
        const title = item.title || `${item.content_type} #${item.content_id || "?"}`;
        const reference = item.content_id
          ? `(${item.content_type === "Issue" ? "#" : "PR #"}${item.content_id})`
          : "";
        const otherFields = item.field_values
          ?.filter((fv) => !["Status", "State", "Column"].includes(fv.name))
          .map((fv) => `**${fv.name}**: ${fv.value ?? "null"}`)
          .join(", ");

        let itemText = `- ${status} ${title} ${reference}`;
        if (otherFields) {
          itemText += ` - ${otherFields}`;
        }
        return itemText;
      })
      .join("\n");
    itemsSection = `\n\n---\n\n## Project Items\n\n${itemsText}`;
  }

  return `---
${frontMatter}
---

# ${project.title}

${body}${itemsSection}
`;
}

