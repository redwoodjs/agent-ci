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
  projectId: string,
  versionHash: string
): string {
  return `github-ingest/${repoOwner}/${repoName}/projects/${projectId}/${versionHash}.md`;
}

export async function processProjectEvent(
  project: GitHubProject,
  eventType: "created" | "edited" | "closed" | "reopened" | "deleted",
  repository: { owner: { login: string }; name: string }
): Promise<void> {
  const repoOwner = repository.owner.login;
  const repoName = repository.name;
  const repoKey = getRepositoryKey(repoOwner, repoName);
  const db = createDb<GitHubDatabase>(
    (env as any).GITHUB_REPO as DurableObjectNamespace<GitHubRepoDurableObject>,
    repoKey
  );

  const versionHash = await generateVersionHash(project);
  const r2Key = getR2Key(repoOwner, repoName, project.id, versionHash);

  if (eventType === "deleted") {
    const existingProject = await db
      .selectFrom("projects")
      .selectAll()
      .where("github_id", "=", project.id)
      .executeTakeFirst();

    if (existingProject) {
      await db
        .updateTable("projects")
        .set({
          state: "deleted",
          updated_at: new Date().toISOString(),
        })
        .where("github_id", "=", project.id)
        .execute();
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

  const existingProject = await db
    .selectFrom("projects")
    .selectAll()
    .where("github_id", "=", project.id)
    .executeTakeFirst();

  if (existingProject) {
    const versionResult = await db
      .insertInto("project_versions")
      .values({
        project_github_id: project.id,
        r2_key: r2Key,
        created_at: now,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow();

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
  } else {
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

    await db
      .updateTable("projects")
      .set({
        latest_version_id: versionResult.id,
      })
      .where("github_id", "=", project.id)
      .execute();
  }

  const markdown = projectToMarkdown(project, {
    github_id: project.id,
    state: state,
    created_at: project.created_at,
    updated_at: now,
    version_hash: versionHash,
  });

  await env.MACHINEN_BUCKET.put(r2Key, markdown);
}

