import { env } from "cloudflare:workers";
import { type Database, createDb } from "rwsdk/db";
import { type migrations } from "../db/migrations";
import { type GitHubRepoDurableObject } from "../db/durableObject";
import {
  projectItemToMarkdown,
  type GitHubProjectItem,
} from "../utils/project-item-to-markdown";

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

async function generateVersionHash(
  projectItem: GitHubProjectItem
): Promise<string> {
  const fieldValuesStr =
    projectItem.field_values?.map((fv) => `${fv.name}:${fv.value}`).join(",") ||
    "";
  const content = `${projectItem.id}-${projectItem.updated_at}-${fieldValuesStr}`;
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(content)
  );
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .substring(0, 16);
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

function getR2Key(
  repoOwner: string,
  repoName: string,
  projectId: string,
  contentType: string,
  contentId: number | string,
  versionHash: string
): string {
  const contentTypePath = contentType.toLowerCase().replace(" ", "-");
  return `github-ingest/${repoOwner}/${repoName}/projects/${projectId}/items/${contentTypePath}/${contentId}/${versionHash}.md`;
}

export async function processProjectItemEvent(
  projectItem: GitHubProjectItem,
  eventType: "created" | "edited" | "deleted",
  repository: { owner: { login: string }; name: string },
  projectId: string
): Promise<void> {
  console.log("[project-item-processor] Starting processProjectItemEvent:", {
    itemId: projectItem.id,
    projectId,
    eventType,
    repository: `${repository.owner.login}/${repository.name}`,
  });
  const repoOwner = repository.owner.login;
  const repoName = repository.name;
  const repoKey = getRepositoryKey(repoOwner, repoName);
  console.log("[project-item-processor] Repository key:", repoKey);

  const db = createDb<GitHubDatabase>(
    (env as any).GITHUB_REPO as DurableObjectNamespace<GitHubRepoDurableObject>,
    repoKey
  );

  const contentId = extractContentId(projectItem);
  console.log("[project-item-processor] Extracted content_id:", {
    contentId,
    content_node_id: projectItem.content_node_id,
    content_id: projectItem.content_id,
  });

  const versionHash = await generateVersionHash(projectItem);
  const r2Key = getR2Key(
    repoOwner,
    repoName,
    projectId,
    projectItem.content_type,
    contentId,
    versionHash
  );
  console.log("[project-item-processor] Generated version hash and R2 key:", {
    versionHash,
    r2Key,
  });

  if (eventType === "deleted") {
    console.log("[project-item-processor] Handling deleted event");
    const existingItem = await db
      .selectFrom("project_items")
      .selectAll()
      .where("github_id", "=", String(projectItem.id))
      .executeTakeFirst();

    if (existingItem) {
      console.log(
        "[project-item-processor] Updating existing item to deleted state"
      );
      await db
        .updateTable("project_items")
        .set({
          state: "deleted",
          updated_at: new Date().toISOString(),
        })
        .where("github_id", "=", String(projectItem.id))
        .execute();
    } else {
      console.log("[project-item-processor] No existing item found to delete");
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
    console.log(
      "[project-item-processor] Project does not exist, creating minimal project record"
    );
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
    console.log("[project-item-processor] Created minimal project record");
  }

  const existingItem = await db
    .selectFrom("project_items")
    .selectAll()
    .where("github_id", "=", String(projectItem.id))
    .executeTakeFirst();

  console.log("[project-item-processor] Existing item check:", {
    exists: !!existingItem,
  });

  if (existingItem) {
    console.log("[project-item-processor] Updating existing item");
    const versionResult = await db
      .insertInto("project_item_versions")
      .values({
        project_item_github_id: String(projectItem.id),
        r2_key: r2Key,
        created_at: now,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow();

    console.log("[project-item-processor] Created version record:", {
      versionId: versionResult.id,
    });

    await db
      .updateTable("project_items")
      .set({
        latest_version_id: versionResult.id,
        updated_at: now,
      })
      .where("github_id", "=", String(projectItem.id))
      .execute();
    console.log("[project-item-processor] Updated item record");
  } else {
    console.log("[project-item-processor] Creating new item");
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

    const versionResult = await db
      .insertInto("project_item_versions")
      .values({
        project_item_github_id: String(projectItem.id),
        r2_key: r2Key,
        created_at: now,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow();

    console.log("[project-item-processor] Created version record:", {
      versionId: versionResult.id,
    });

    await db
      .updateTable("project_items")
      .set({
        latest_version_id: versionResult.id,
      })
      .where("github_id", "=", String(projectItem.id))
      .execute();
    console.log("[project-item-processor] Updated item with latest_version_id");
  }

  const markdown = projectItemToMarkdown(projectItem, {
    github_id: String(projectItem.id),
    project_github_id: projectId,
    content_id: contentId,
    content_type: projectItem.content_type,
    state: "active",
    created_at: projectItem.created_at,
    updated_at: now,
    version_hash: versionHash,
  });

  console.log("[project-item-processor] Storing markdown to R2:", r2Key);
  await env.MACHINEN_BUCKET.put(r2Key, markdown);
  console.log("[project-item-processor] Successfully stored to R2");
}
