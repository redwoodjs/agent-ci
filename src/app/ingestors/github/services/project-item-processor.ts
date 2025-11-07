import { env } from "cloudflare:workers";
import { type Database, createDb } from "rwsdk/db";
import { type migrations } from "../db/migrations";
import { type GitHubRepoDurableObject } from "../db/durableObject";
import {
  projectItemToMarkdown,
  type GitHubProjectItem,
} from "../utils/project-item-to-markdown";
import { generateDiff } from "../utils/diff";

type GitHubDatabase = Database<typeof migrations>;

declare module "rwsdk/worker" {
  interface WorkerEnv {
    GITHUB_REPO: DurableObjectNamespace<GitHubRepoDurableObject>;
    MACHINEN_BUCKET: R2Bucket;
  }
}

function getRepositoryKey(repoOwner: string, repoName: string): string {
  return `${repoOwner}/${repoName}`;
}

function getLatestR2Key(
  repoOwner: string,
  repoName: string,
  projectId: string,
  contentType: string,
  contentId: number | string
): string {
  const contentTypePath = contentType.toLowerCase().replace(" ", "-");
  return `github/${repoOwner}/${repoName}/projects/${projectId}/items/${contentTypePath}/${contentId}/latest.md`;
}

function getHistoryR2Key(
  repoOwner: string,
  repoName: string,
  projectId: string,
  contentType: string,
  contentId: number | string,
  timestampForFilename: string
): string {
  const contentTypePath = contentType.toLowerCase().replace(" ", "-");
  return `github/${repoOwner}/${repoName}/projects/${projectId}/items/${contentTypePath}/${contentId}/history/${timestampForFilename}.json`;
}

function extractContentId(projectItem: GitHubProjectItem): number {
  if (projectItem.content_id !== undefined && projectItem.content_id !== null) {
    return projectItem.content_id;
  }

  if (projectItem.content_node_id) {
    try {
      const nodeId = projectItem.content_node_id;
      const decoded = atob(nodeId);
      const match = decoded.match(/:(\d+)$/);
      if (match && match[1]) {
        const numericId = parseInt(match[1], 10);
        if (!isNaN(numericId)) {
          return numericId;
        }
      }
    } catch (e) {
      console.warn(
        "[project-item-processor] Failed to decode content_node_id:",
        e,
        "nodeId:",
        projectItem.content_node_id
      );
    }

    try {
      const nodeId = projectItem.content_node_id;
      const match = nodeId.match(/(\d+)$/);
      if (match && match[1]) {
        const numericId = parseInt(match[1], 10);
        if (!isNaN(numericId)) {
          return numericId;
        }
      }
    } catch (e) {
      console.warn(
        "[project-item-processor] Failed to extract numeric ID from content_node_id:",
        e
      );
    }
  }

  throw new Error(
    `Unable to extract content_id from project item. content_node_id: ${projectItem.content_node_id}, content_id: ${projectItem.content_id}, id: ${projectItem.id}`
  );
}

async function parseProjectItemFromMarkdown(
  markdown: string
): Promise<GitHubProjectItem | null> {
  try {
    const frontMatterMatch = markdown.match(/^---\n([\s\S]*?)\n---/);
    if (!frontMatterMatch) {
      return null;
    }

    const frontMatter = frontMatterMatch[1];
    const lines = frontMatter.split("\n");
    const metadata: Record<string, string> = {};

    for (const line of lines) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match) {
        metadata[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
    }

    const fieldsMatch = markdown.match(/\*\*Fields:\*\*\n([\s\S]*?)(?:\n\n|$)/);
    const fieldValues: Array<{
      field_node_id: string;
      name: string;
      value: string | number | null;
    }> = [];
    if (fieldsMatch) {
      const fieldLines = fieldsMatch[1].split("\n");
      for (const line of fieldLines) {
        const fieldMatch = line.match(/^- \*\*(\w+)\*\*:\s*(.+)$/);
        if (fieldMatch) {
          const value = fieldMatch[2] === "null" ? null : fieldMatch[2];
          fieldValues.push({
            field_node_id: "",
            name: fieldMatch[1],
            value: value as string | number | null,
          });
        }
      }
    }

    return {
      id: metadata.github_id || "",
      content_id: metadata.content_id
        ? parseInt(metadata.content_id, 10)
        : undefined,
      content_type:
        (metadata.content_type as "Issue" | "PullRequest" | "DraftIssue") ||
        "Issue",
      project_node_id: metadata.project_github_id || "",
      field_values: fieldValues.length > 0 ? fieldValues : undefined,
      created_at: metadata.created_at || "",
      updated_at: metadata.updated_at || "",
    };
  } catch (e) {
    console.warn(
      "[project-item-processor] Failed to parse project item from markdown:",
      e
    );
    return null;
  }
}

export async function processProjectItemEvent(
  projectItem: GitHubProjectItem,
  eventType: "created" | "edited" | "deleted",
  repository: { owner: { login: string }; name: string },
  projectId: string
): Promise<void> {
  const repoOwner = repository.owner.login;
  const repoName = repository.name;
  const repoKey = getRepositoryKey(repoOwner, repoName);
  const db = createDb<GitHubDatabase>(
    (env as any).GITHUB_REPO as DurableObjectNamespace<GitHubRepoDurableObject>,
    repoKey
  );

  const contentId = extractContentId(projectItem);
  const latestR2Key = getLatestR2Key(
    repoOwner,
    repoName,
    projectId,
    projectItem.content_type,
    contentId
  );

  if (eventType === "deleted") {
    const existingItem = await db
      .selectFrom("project_items")
      .selectAll()
      .where("github_id", "=", String(projectItem.id))
      .executeTakeFirst();

    if (existingItem) {
      await db
        .updateTable("project_items")
        .set({
          state: "deleted",
          updated_at: new Date().toISOString(),
        })
        .where("github_id", "=", String(projectItem.id))
        .execute();
    }
    return;
  }

  const now = new Date().toISOString();

  const existingProject = await db
    .selectFrom("projects")
    .selectAll()
    .where("github_id", "=", projectId)
    .executeTakeFirst();

  if (!existingProject) {
    await db
      .insertInto("projects")
      .values({
        github_id: projectId,
        title: `Project ${projectId}`,
        body: null,
        state: "open",
        created_at: now,
        updated_at: now,
      } as any)
      .execute();
  }

  const existingItem = await db
    .selectFrom("project_items")
    .selectAll()
    .where("github_id", "=", String(projectItem.id))
    .executeTakeFirst();

  const existingLatestMd = await env.MACHINEN_BUCKET.get(latestR2Key);
  let oldProjectItem: GitHubProjectItem | null = null;

  if (existingLatestMd) {
    const markdown = await existingLatestMd.text();
    oldProjectItem = await parseProjectItemFromMarkdown(markdown);
  }

  const diff = generateDiff(
    oldProjectItem as unknown as Record<string, unknown> | null,
    projectItem as unknown as Record<string, unknown>
  );
  const hasChanges = diff !== null && Object.keys(diff.changes).length > 0;

  const fieldValuesStr =
    projectItem.field_values?.map((fv) => `${fv.name}:${fv.value}`).join(",") ||
    "";
  const versionHash = `${projectItem.id}-${projectItem.updated_at}-${fieldValuesStr}`;
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(versionHash)
  );
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const versionHashStr = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .substring(0, 16);

  const markdown = projectItemToMarkdown(projectItem, {
    github_id: String(projectItem.id),
    project_github_id: projectId,
    content_id: contentId,
    content_type: projectItem.content_type,
    state: "active",
    created_at: projectItem.created_at,
    updated_at: now,
    version_hash: versionHashStr,
  });

  await env.MACHINEN_BUCKET.put(latestR2Key, markdown);

  if (hasChanges && diff) {
    const historyR2Key = getHistoryR2Key(
      repoOwner,
      repoName,
      projectId,
      projectItem.content_type,
      contentId,
      diff.timestampForFilename
    );
    await env.MACHINEN_BUCKET.put(historyR2Key, JSON.stringify(diff, null, 2));
  }

  if (existingItem) {
    await db
      .updateTable("project_items")
      .set({
        updated_at: now,
      })
      .where("github_id", "=", String(projectItem.id))
      .execute();
  } else {
    await db
      .insertInto("project_items")
      .values({
        github_id: String(projectItem.id),
        project_github_id: projectId,
        content_id: contentId,
        content_type: projectItem.content_type,
        state: "active",
        created_at: projectItem.created_at,
        updated_at: now,
      } as any)
      .execute();
  }
}
