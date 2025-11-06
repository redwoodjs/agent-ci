export interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string | null;
  author: {
    login: string;
    avatar_url?: string;
  };
  assets?: Array<{
    name: string;
    size: number;
    browser_download_url: string;
  }>;
}

export interface ReleaseMetadata {
  github_id: number;
  tag_name: string;
  state: "draft" | "prerelease" | "published" | "deleted";
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

export function releaseToMarkdown(
  release: GitHubRelease,
  metadata: ReleaseMetadata
): string {
  const frontMatter = [
    `github_id: ${metadata.github_id}`,
    `tag_name: ${escapeYamlValue(metadata.tag_name)}`,
    `state: ${escapeYamlValue(metadata.state)}`,
    `created_at: ${escapeYamlValue(metadata.created_at)}`,
    `updated_at: ${escapeYamlValue(metadata.updated_at)}`,
    `version_hash: ${escapeYamlValue(metadata.version_hash)}`,
  ].join("\n");

  const assets =
    release.assets && release.assets.length > 0
      ? release.assets
          .map(
            (asset) =>
              `- [${asset.name}](${asset.browser_download_url}) (${asset.size} bytes)`
          )
          .join("\n")
      : "";

  const name = release.name || release.tag_name;
  const body = release.body || "_No release notes provided._";

  return `---
${frontMatter}
---

# ${name}

**Author:** @${release.author.login}
${assets ? `\n**Assets:**\n${assets}\n` : ""}

---

${body}
`;
}

