import { env } from "cloudflare:workers";
import { type Database, createDb } from "rwsdk/db";
import { type migrations } from "../db/migrations";
import { type GitHubRepoDurableObject } from "../db/durableObject";
import { issueToMarkdown, type GitHubIssue } from "../utils/issue-to-markdown";

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

async function generateVersionHash(issue: GitHubIssue): Promise<string> {
  const content = `${issue.id}-${issue.updated_at}-${issue.body || ""}-${
    issue.title
  }`;
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

function getR2Key(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  versionHash: string
): string {
  return `github-ingest/${repoOwner}/${repoName}/issues/${issueNumber}/${versionHash}.md`;
}

export async function processIssueEvent(
  issue: GitHubIssue,
  eventType: "opened" | "edited" | "closed" | "reopened" | "deleted",
  repository: { owner: { login: string }; name: string }
): Promise<void> {
  const repoOwner = repository.owner.login;
  const repoName = repository.name;
  const repoKey = getRepositoryKey(repoOwner, repoName);
  const db = createDb<GitHubDatabase>(
    (env as any).GITHUB_REPO as DurableObjectNamespace<GitHubRepoDurableObject>,
    repoKey
  );

  const versionHash = await generateVersionHash(issue);
  const r2Key = getR2Key(repoOwner, repoName, issue.number, versionHash);

  if (eventType === "deleted") {
    const existingIssue = await db
      .selectFrom("issues")
      .selectAll()
      .where("github_id", "=", issue.id)
      .executeTakeFirst();

    if (existingIssue) {
      await db
        .updateTable("issues")
        .set({
          state: "deleted",
          updated_at: new Date().toISOString(),
        })
        .where("github_id", "=", issue.id)
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
    state = issue.state === "closed" ? "closed" : "open";
  }

  const existingIssue = await db
    .selectFrom("issues")
    .selectAll()
    .where("github_id", "=", issue.id)
    .executeTakeFirst();

  const existingVersion = await db
    .selectFrom("issue_versions")
    .selectAll()
    .where("r2_key", "=", r2Key)
    .executeTakeFirst();

  if (existingVersion) {
    if (existingIssue) {
      await db
        .updateTable("issues")
        .set({
          title: issue.title,
          state: state,
          latest_version_id: existingVersion.id,
          updated_at: now,
        })
        .where("github_id", "=", issue.id)
        .execute();
    }
    return;
  }

  if (existingIssue) {
    const versionResult = await db
      .insertInto("issue_versions")
      .values({
        issue_github_id: issue.id,
        r2_key: r2Key,
        created_at: now,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .updateTable("issues")
      .set({
        title: issue.title,
        state: state,
        latest_version_id: versionResult.id,
        updated_at: now,
      })
      .where("github_id", "=", issue.id)
      .execute();
  } else {
    await db
      .insertInto("issues")
      .values({
        github_id: issue.id,
        number: issue.number,
        title: issue.title,
        state: state,
        created_at: issue.created_at,
        updated_at: now,
      } as any)
      .execute();

    const versionResult = await db
      .insertInto("issue_versions")
      .values({
        issue_github_id: issue.id,
        r2_key: r2Key,
        created_at: now,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .updateTable("issues")
      .set({
        latest_version_id: versionResult.id,
      })
      .where("github_id", "=", issue.id)
      .execute();
  }

  const markdown = issueToMarkdown(issue, {
    github_id: issue.id,
    number: issue.number,
    state: state,
    created_at: issue.created_at,
    updated_at: now,
    version_hash: versionHash,
  });

  const existingR2Object = await env.MACHINEN_BUCKET.head(r2Key);
  if (!existingR2Object) {
    await env.MACHINEN_BUCKET.put(r2Key, markdown);
  }
}
