import type {
  GitHubProject,
  ProjectItemWithTitle,
} from "./project-to-markdown";
import type { ProjectMetadata } from "./project-to-markdown";

export interface ProjectLatestJson {
  github_id: string;
  number?: number;
  state: "open" | "closed" | "deleted";
  owner: string;
  owner_type: string;
  created_at: string;
  updated_at: string;
  title: string;
  body: string | null;
  items?: Array<{
    id: string;
    content_id?: number;
    content_type: "Issue" | "PullRequest" | "DraftIssue";
    title?: string;
    field_values?: Array<{
      name: string;
      value: string | number | null;
    }>;
  }>;
  [key: string]: unknown;
}

export function projectToJson(
  project: GitHubProject,
  metadata: ProjectMetadata,
  items?: ProjectItemWithTitle[]
): ProjectLatestJson {
  const json: ProjectLatestJson = {
    github_id: metadata.github_id,
    state: metadata.state,
    owner: project.owner.login,
    owner_type: project.owner.type,
    created_at: metadata.created_at,
    updated_at: metadata.updated_at,
    title: project.title,
    body: project.body,
  };

  if (project.number) {
    json.number = project.number;
  }

  if (items && items.length > 0) {
    json.items = items.map((item) => ({
      id: item.id,
      content_id: item.content_id,
      content_type: item.content_type,
      title: item.title,
      field_values: item.field_values,
    }));
  }

  return json;
}

