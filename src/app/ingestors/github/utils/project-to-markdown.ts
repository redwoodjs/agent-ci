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

export function projectToMarkdown(
  project: GitHubProject,
  metadata: ProjectMetadata
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

  return `---
${frontMatter}
---

# ${project.title}

${body}
`;
}

