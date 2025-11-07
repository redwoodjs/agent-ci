import { env } from "cloudflare:workers";
import { type Database, createDb } from "rwsdk/db";
import { type migrations } from "../db/migrations";
import { type GitHubRepoDurableObject } from "../db/durableObject";
import { projectToMarkdown, type GitHubProject } from "../utils/project-to-markdown";

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

async function generateVersionHash(project: GitHubProject): Promise<string> {
  const content = `${project.id}-${project.updated_at}-${project.body || ""}-${project.title}`;
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
  projectIdentifier: string | number,
  versionHash: string
): string {
  return `github/${repoOwner}/${repoName}/projects/${projectIdentifier}/${versionHash}.md`;
}

export async function processProjectEvent(
  project: GitHubProject,
  eventType: "created" | "edited" | "closed" | "reopened" | "deleted",
  repository: { owner: { login: string }; name: string }
): Promise<void> {
  console.log("[project-processor] Starting processProjectEvent:", { projectId: project.id, eventType, repository: `${repository.owner.login}/${repository.name}` });
  const repoOwner = repository.owner.login;
  const repoName = repository.name;
  const repoKey = getRepositoryKey(repoOwner, repoName);
  console.log("[project-processor] Repository key:", repoKey);
  
  const db = createDb<GitHubDatabase>(
    (env as any).GITHUB_REPO as DurableObjectNamespace<GitHubRepoDurableObject>,
    repoKey
  );

  const versionHash = await generateVersionHash(project);
  const projectIdentifier = project.number || project.id;
  const r2Key = getR2Key(repoOwner, repoName, projectIdentifier, versionHash);
  console.log("[project-processor] Generated version hash and R2 key:", { versionHash, r2Key, projectIdentifier });

  if (eventType === "deleted") {
    console.log("[project-processor] Handling deleted event");
    const existingProject = await db
      .selectFrom("projects")
      .selectAll()
      .where("github_id", "=", project.id)
      .executeTakeFirst();

    if (existingProject) {
      console.log("[project-processor] Updating existing project to deleted state");
      await db
        .updateTable("projects")
        .set({
          state: "deleted",
          updated_at: new Date().toISOString(),
        })
        .where("github_id", "=", project.id)
        .execute();
    } else {
      console.log("[project-processor] No existing project found to delete");
    }
    return;
  }

  const now = new Date().toISOString();
  let state: "open" | "closed";
  if (eventType === "closed") {
    state = "closed";
  } else if (eventType === "reopened") {
    state = "open";
  } else {
    state = project.state === "closed" ? "closed" : "open";
  }
  console.log("[project-processor] Determined state:", state);

  const existingProject = await db
    .selectFrom("projects")
    .selectAll()
    .where("github_id", "=", project.id)
    .executeTakeFirst();

  console.log("[project-processor] Existing project check:", { exists: !!existingProject });

  const existingVersion = await db
    .selectFrom("project_versions")
    .selectAll()
    .where("r2_key", "=", r2Key)
    .executeTakeFirst();

  if (existingVersion) {
    if (existingProject) {
      await db
        .updateTable("projects")
        .set({
          title: project.title,
          body: project.body,
          state: state,
          latest_version_id: existingVersion.id,
          updated_at: now,
        })
        .where("github_id", "=", project.id)
        .execute();
    }
    return;
  }

  if (existingProject) {
    console.log("[project-processor] Updating existing project");
    const versionResult = await db
      .insertInto("project_versions")
      .values({
        project_github_id: project.id,
        r2_key: r2Key,
        created_at: now,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow();

    console.log("[project-processor] Created version record:", { versionId: versionResult.id });

    await db
      .updateTable("projects")
      .set({
        title: project.title,
        body: project.body,
        state: state,
        latest_version_id: versionResult.id,
        updated_at: now,
      })
      .where("github_id", "=", project.id)
      .execute();
    console.log("[project-processor] Updated project record");
  } else {
    console.log("[project-processor] Creating new project");
    await db
      .insertInto("projects")
      .values({
        github_id: project.id,
        title: project.title,
        body: project.body,
        state: state,
        created_at: project.created_at,
        updated_at: now,
      } as any)
      .execute();

    const versionResult = await db
      .insertInto("project_versions")
      .values({
        project_github_id: project.id,
        r2_key: r2Key,
        created_at: now,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow();

    console.log("[project-processor] Created version record:", { versionId: versionResult.id });

    await db
      .updateTable("projects")
      .set({
        latest_version_id: versionResult.id,
      })
      .where("github_id", "=", project.id)
      .execute();
    console.log("[project-processor] Updated project with latest_version_id");
  }

  const markdown = projectToMarkdown(project, {
    github_id: project.id,
    state: state,
    created_at: project.created_at,
    updated_at: now,
    version_hash: versionHash,
  });

  console.log("[project-processor] Storing markdown to R2:", r2Key);
  const existingR2Object = await env.MACHINEN_BUCKET.head(r2Key);
  if (!existingR2Object) {
    await env.MACHINEN_BUCKET.put(r2Key, markdown);
    console.log("[project-processor] Successfully stored to R2");
  } else {
    console.log("[project-processor] R2 object already exists, skipping");
  }
}

