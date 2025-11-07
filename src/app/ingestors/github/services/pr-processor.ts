import { env } from "cloudflare:workers";
import { type Database, createDb } from "rwsdk/db";
import { type migrations } from "../db/migrations";
import { type GitHubRepoDurableObject } from "../db/durableObject";
import { prToMarkdown, type GitHubPullRequest } from "../utils/pr-to-markdown";

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

async function generateVersionHash(pr: GitHubPullRequest): Promise<string> {
  const content = `${pr.id}-${pr.updated_at}-${pr.body || ""}-${pr.title}-${pr.head.sha}`;
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
  prNumber: number,
  versionHash: string
): string {
  return `github-ingest/${repoOwner}/${repoName}/pull-requests/${prNumber}/${versionHash}.md`;
}

export async function processPullRequestEvent(
  pr: GitHubPullRequest,
  eventType: "opened" | "edited" | "closed" | "reopened" | "merged" | "synchronize" | "deleted",
  repository: { owner: { login: string }; name: string }
): Promise<void> {
  const repoOwner = repository.owner.login;
  const repoName = repository.name;
  const repoKey = getRepositoryKey(repoOwner, repoName);
  const db = createDb<GitHubDatabase>(
    (env as any).GITHUB_REPO as DurableObjectNamespace<GitHubRepoDurableObject>,
    repoKey
  );

  const versionHash = await generateVersionHash(pr);
  const r2Key = getR2Key(repoOwner, repoName, pr.number, versionHash);

  if (eventType === "deleted") {
    const existingPR = await db
      .selectFrom("pull_requests")
      .selectAll()
      .where("github_id", "=", pr.id)
      .executeTakeFirst();

    if (existingPR) {
      await db
        .updateTable("pull_requests")
        .set({
          state: "deleted",
          updated_at: new Date().toISOString(),
        })
        .where("github_id", "=", pr.id)
        .execute();
    }
    return;
  }

  const now = new Date().toISOString();
  let state: "open" | "closed" | "merged";
  if (eventType === "merged") {
    state = "merged";
  } else if (eventType === "closed") {
    state = "closed";
  } else if (eventType === "reopened") {
    state = "open";
  } else {
    state = pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open";
  }

  const existingPR = await db
    .selectFrom("pull_requests")
    .selectAll()
    .where("github_id", "=", pr.id)
    .executeTakeFirst();

  const existingVersion = await db
    .selectFrom("pull_request_versions")
    .selectAll()
    .where("r2_key", "=", r2Key)
    .executeTakeFirst();

  if (existingVersion) {
    if (existingPR) {
      await db
        .updateTable("pull_requests")
        .set({
          title: pr.title,
          state: state,
          latest_version_id: existingVersion.id,
          updated_at: now,
        })
        .where("github_id", "=", pr.id)
        .execute();
    }
    return;
  }

  if (existingPR) {
    const versionResult = await db
      .insertInto("pull_request_versions")
      .values({
        pull_request_github_id: pr.id,
        r2_key: r2Key,
        created_at: now,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .updateTable("pull_requests")
      .set({
        title: pr.title,
        state: state,
        latest_version_id: versionResult.id,
        updated_at: now,
      })
      .where("github_id", "=", pr.id)
      .execute();
  } else {
    await db
      .insertInto("pull_requests")
      .values({
        github_id: pr.id,
        number: pr.number,
        title: pr.title,
        state: state,
        created_at: pr.created_at,
        updated_at: now,
      } as any)
      .execute();

    const versionResult = await db
      .insertInto("pull_request_versions")
      .values({
        pull_request_github_id: pr.id,
        r2_key: r2Key,
        created_at: now,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .updateTable("pull_requests")
      .set({
        latest_version_id: versionResult.id,
      })
      .where("github_id", "=", pr.id)
      .execute();
  }

  const markdown = prToMarkdown(pr, {
    github_id: pr.id,
    number: pr.number,
    state: state,
    created_at: pr.created_at,
    updated_at: now,
    version_hash: versionHash,
  });

  const existingR2Object = await env.MACHINEN_BUCKET.head(r2Key);
  if (!existingR2Object) {
    await env.MACHINEN_BUCKET.put(r2Key, markdown);
  }
}

