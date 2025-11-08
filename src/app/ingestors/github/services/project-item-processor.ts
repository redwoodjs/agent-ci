import { processProjectEvent } from "./project-processor";
import type { GitHubProjectItem } from "../utils/project-item-to-markdown";
import type { GitHubProject } from "../utils/project-to-markdown";

export async function processProjectItemEvent(
  projectItem: GitHubProjectItem,
  eventType: "created" | "edited" | "deleted",
  repository: { owner: { login: string }; name: string },
  projectId: string
): Promise<void> {
  const partialProject: GitHubProject = {
    id: projectId,
    title: "",
    body: null,
    state: "open",
    created_at: "",
    updated_at: "",
    owner: {
      login: repository.owner.login,
      type: "Organization",
    },
  };
  await processProjectEvent(partialProject, "edited", repository);
}
