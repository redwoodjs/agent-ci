import { env } from "cloudflare:workers";
import { type Database, createDb } from "rwsdk/db";
import { type migrations } from "../db/migrations";
import { type GitHubRepoDurableObject } from "../db/durableObject";
import { type GitHubIssue } from "../utils/issue-to-markdown";
import { issueToJson, type IssueLatestJson } from "../utils/issue-to-json";
import {
  fetchGitHubEntity,
  fetchIssueComments,
  type GitHubComment,
} from "../utils/github-api";
import { generateDiff, type EntityDiff } from "../utils/diff";

type GitHubDatabase = Database<typeof migrations>;

declare module "rwsdk/worker" {
  interface WorkerEnv {
    GITHUB_REPO: DurableObjectNamespace<GitHubRepoDurableObject>;
    MACHINEN_BUCKET: R2Bucket;
    GITHUB_TOKEN?: string;
  }
}

function getRepositoryKey(repoOwner: string, repoName: string): string {
  return `${repoOwner}/${repoName}`;
}

function getLatestR2Key(
  repoOwner: string,
  repoName: string,
  issueNumber: number
): string {
  return `github/${repoOwner}/${repoName}/issues/${issueNumber}/latest.json`;
}

function getHistoryR2Key(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  timestampForFilename: string
): string {
  return `github/${repoOwner}/${repoName}/issues/${issueNumber}/history/${timestampForFilename}.json`;
}

async function parseIssueFromJson(
  jsonText: string
): Promise<GitHubIssue | null> {
  try {
    const json = JSON.parse(jsonText) as IssueLatestJson;
    return {
      id: json.github_id,
      number: json.number,
      title: json.title,
      body: json.body,
      state: json.state as "open" | "closed",
      created_at: json.created_at,
      updated_at: json.updated_at,
      user: { login: json.author },
    };
  } catch (e) {
    console.warn("[issue-processor] Failed to parse issue from JSON:", e);
    return null;
  }
}

export async function processIssueEvent(
  partialIssue: GitHubIssue,
  eventType: "opened" | "edited" | "closed" | "reopened" | "deleted",
  repository: { owner: { login: string }; name: string }
): Promise<void> {
  console.log("[issue-processor] Starting processIssueEvent:", {
    eventType,
    issueNumber: partialIssue.number,
    repo: `${repository.owner.login}/${repository.name}`,
  });
  const repoOwner = repository.owner.login;
  const repoName = repository.name;
  const repoKey = getRepositoryKey(repoOwner, repoName);
  const db = createDb<GitHubDatabase>(
    (env as any).GITHUB_REPO as DurableObjectNamespace<GitHubRepoDurableObject>,
    repoKey
  );

  if (eventType === "deleted") {
    const existingIssue = await db
      .selectFrom("issues")
      .selectAll()
      .where("github_id", "=", partialIssue.id)
      .executeTakeFirst();

    if (existingIssue) {
      await db
        .updateTable("issues")
        .set({
          state: "deleted",
          updated_at: new Date().toISOString(),
        })
        .where("github_id", "=", partialIssue.id)
        .execute();
    }
    return;
  }

  const issueNumber = partialIssue.number || partialIssue.id;
  const latestR2Key = getLatestR2Key(repoOwner, repoName, issueNumber);

  let fullIssue: GitHubIssue;
  try {
    fullIssue = await fetchGitHubEntity<GitHubIssue>(
      `https://api.github.com/repos/${repoOwner}/${repoName}/issues/${issueNumber}`
    );
  } catch (error) {
    console.error(
      `[issue-processor] Failed to fetch full issue #${issueNumber}:`,
      error
    );
    throw error;
  }

  let comments: GitHubComment[] = [];
  try {
    comments = await fetchIssueComments(repoOwner, repoName, issueNumber);
  } catch (error) {
    console.warn(
      `[issue-processor] Failed to fetch comments for issue #${issueNumber}:`,
      error
    );
  }

  const now = new Date().toISOString();
  let state: "open" | "closed";
  if (eventType === "closed") {
    state = "closed";
  } else if (eventType === "reopened") {
    state = "open";
  } else {
    state = fullIssue.state === "closed" ? "closed" : "open";
  }

  const existingIssue = await db
    .selectFrom("issues")
    .selectAll()
    .where("github_id", "=", fullIssue.id)
    .executeTakeFirst();

  const existingLatestJson = await env.MACHINEN_BUCKET.get(latestR2Key);
  let oldIssue: GitHubIssue | null = null;

  if (existingLatestJson) {
    const jsonText = await existingLatestJson.text();
    oldIssue = await parseIssueFromJson(jsonText);
  }

  const diff = generateDiff(
    oldIssue as unknown as Record<string, unknown> | null,
    fullIssue as unknown as Record<string, unknown>
  );
  const hasChanges = diff !== null && Object.keys(diff.changes).length > 0;

  const versionHash = `${fullIssue.id}-${fullIssue.updated_at}-${
    fullIssue.body || ""
  }-${fullIssue.title}`;
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

  const url = `https://github.com/${repoOwner}/${repoName}/issues/${issueNumber}`;
  const json = issueToJson(
    fullIssue,
    {
      github_id: fullIssue.id,
      number: fullIssue.number,
      state: state,
      created_at: fullIssue.created_at,
      updated_at: now,
      version_hash: versionHashStr,
    },
    comments,
    url
  );

  console.log("[issue-processor] Uploading issue to R2:", { latestR2Key });
  await env.MACHINEN_BUCKET.put(
    latestR2Key,
    JSON.stringify(json, null, 2)
  );
  console.log("[issue-processor] Issue uploaded to R2 successfully");

  if (hasChanges && diff) {
    const historyR2Key = getHistoryR2Key(
      repoOwner,
      repoName,
      issueNumber,
      diff.timestampForFilename
    );
    await env.MACHINEN_BUCKET.put(historyR2Key, JSON.stringify(diff, null, 2));
  }

  if (existingIssue) {
    await db
      .updateTable("issues")
      .set({
        title: fullIssue.title,
        state: state,
        updated_at: now,
      })
      .where("github_id", "=", fullIssue.id)
      .execute();
  } else {
    await db
      .insertInto("issues")
      .values({
        github_id: fullIssue.id,
        number: fullIssue.number,
        title: fullIssue.title,
        state: state,
        created_at: fullIssue.created_at,
        updated_at: now,
      } as any)
      .execute();
  }
}
