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

async function generateVersionHash(projectItem: GitHubProjectItem): Promise<string> {
  const fieldValuesStr =
    projectItem.field_values
      ?.map((fv) => `${fv.name}:${fv.value}`)
      .join(",") || "";
  const content = `${projectItem.id}-${projectItem.updated_at}-${fieldValuesStr}`;
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(content)
  );
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").substring(0, 16);
}

function getR2Key(
  repoOwner: string,
  repoName: string,
  projectId: string,
  contentType: string,
  contentId: number,
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
  const repoOwner = repository.owner.login;
  const repoName = repository.name;
  const repoKey = getRepositoryKey(repoOwner, repoName);
  const db = createDb<GitHubDatabase>(
    (env as any).GITHUB_REPO as DurableObjectNamespace<GitHubRepoDurableObject>,
    repoKey
  );

  const versionHash = await generateVersionHash(projectItem);
  const r2Key = getR2Key(
    repoOwner,
    repoName,
    projectId,
    projectItem.content_type,
    projectItem.content_id,
    versionHash
  );

  if (eventType === "deleted") {
    const existingItem = await db
      .selectFrom("project_items")
      .selectAll()
      .where("github_id", "=", projectItem.id)
      .executeTakeFirst();

    if (existingItem) {
      await db
        .updateTable("project_items")
        .set({
          state: "deleted",
          updated_at: new Date().toISOString(),
        })
        .where("github_id", "=", projectItem.id)
        .execute();
    }
    return;
  }

  const now = new Date().toISOString();

  const existingItem = await db
    .selectFrom("project_items")
    .selectAll()
    .where("github_id", "=", projectItem.id)
    .executeTakeFirst();

  if (existingItem) {
    const versionResult = await db
      .insertInto("project_item_versions")
      .values({
        project_item_github_id: projectItem.id,
        r2_key: r2Key,
        created_at: now,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .updateTable("project_items")
      .set({
        latest_version_id: versionResult.id,
        updated_at: now,
      })
      .where("github_id", "=", projectItem.id)
      .execute();
  } else {
    await db
      .insertInto("project_items")
      .values({
        github_id: projectItem.id,
        project_github_id: projectId,
        content_id: projectItem.content_id,
        content_type: projectItem.content_type,
        state: "active",
        created_at: projectItem.created_at,
        updated_at: now,
      } as any)
      .execute();

    const versionResult = await db
      .insertInto("project_item_versions")
      .values({
        project_item_github_id: projectItem.id,
        r2_key: r2Key,
        created_at: now,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .updateTable("project_items")
      .set({
        latest_version_id: versionResult.id,
      })
      .where("github_id", "=", projectItem.id)
      .execute();
  }

  const markdown = projectItemToMarkdown(projectItem, {
    github_id: projectItem.id,
    project_github_id: projectId,
    content_id: projectItem.content_id,
    content_type: projectItem.content_type,
    state: "active",
    created_at: projectItem.created_at,
    updated_at: now,
    version_hash: versionHash,
  });

  await env.MACHINEN_BUCKET.put(r2Key, markdown);
}

