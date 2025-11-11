import { env } from "cloudflare:workers";
import { type Database, createDb } from "rwsdk/db";
import { type migrations } from "../db/migrations";
import { type GitHubRepoDurableObject } from "../db/durableObject";
import { type GitHubPullRequest } from "../utils/pr-to-markdown";
import { prToJson, type PRLatestJson } from "../utils/pr-to-json";
import {
  fetchGitHubEntity,
  fetchIssueComments,
  fetchPullRequestComments,
  type GitHubComment,
} from "../utils/github-api";
import { generateDiff } from "../utils/diff";

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
  prNumber: number
): string {
  return `github/${repoOwner}/${repoName}/pull-requests/${prNumber}/latest.json`;
}

function getHistoryR2Key(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  timestampForFilename: string
): string {
  return `github/${repoOwner}/${repoName}/pull-requests/${prNumber}/history/${timestampForFilename}.json`;
}

async function parsePRFromJson(
  jsonText: string
): Promise<GitHubPullRequest | null> {
  try {
    const json = JSON.parse(jsonText) as PRLatestJson;
    return {
      id: json.github_id,
      number: json.number,
      title: json.title,
      body: json.body,
      state: (json.state === "merged" ? "closed" : json.state) as
        | "open"
        | "closed",
      merged: json.state === "merged",
      created_at: json.created_at,
      updated_at: json.updated_at,
      user: { login: json.author },
      base: { ref: "", sha: "" },
      head: { ref: "", sha: "" },
    };
  } catch (e) {
    console.warn("[pr-processor] Failed to parse PR from JSON:", e);
    return null;
  }
}

export async function processPullRequestEvent(
  partialPR: GitHubPullRequest,
  eventType:
    | "opened"
    | "edited"
    | "closed"
    | "reopened"
    | "merged"
    | "synchronize"
    | "deleted",
  repository: { owner: { login: string }; name: string }
): Promise<void> {
  const repoOwner = repository.owner.login;
  const repoName = repository.name;
  const repoKey = getRepositoryKey(repoOwner, repoName);
  const db = createDb<GitHubDatabase>(
    (env as any).GITHUB_REPO as DurableObjectNamespace<GitHubRepoDurableObject>,
    repoKey
  );

  if (eventType === "deleted") {
    const existingPR = await db
      .selectFrom("pull_requests")
      .selectAll()
      .where("github_id", "=", partialPR.id)
      .executeTakeFirst();

    if (existingPR) {
      await db
        .updateTable("pull_requests")
        .set({
          state: "deleted",
          updated_at: new Date().toISOString(),
        })
        .where("github_id", "=", partialPR.id)
        .execute();
    }
    return;
  }

  const prNumber = partialPR.number || partialPR.id;
  const latestR2Key = getLatestR2Key(repoOwner, repoName, prNumber);

  let fullPR: GitHubPullRequest;
  try {
    fullPR = await fetchGitHubEntity<GitHubPullRequest>(
      `https://api.github.com/repos/${repoOwner}/${repoName}/pulls/${prNumber}`
    );
  } catch (error) {
    console.error(
      `[pr-processor] Failed to fetch full PR #${prNumber}:`,
      error
    );
    throw error;
  }

  let comments: GitHubComment[] = [];
  try {
    const [issueComments, reviewComments] = await Promise.all([
      fetchIssueComments(repoOwner, repoName, prNumber).catch(() => []),
      fetchPullRequestComments(repoOwner, repoName, prNumber).catch(() => []),
    ]);
    comments = [...issueComments, ...reviewComments];
  } catch (error) {
    console.warn(
      `[pr-processor] Failed to fetch comments for PR #${prNumber}:`,
      error
    );
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
    state = fullPR.merged
      ? "merged"
      : fullPR.state === "closed"
      ? "closed"
      : "open";
  }

  const existingPR = await db
    .selectFrom("pull_requests")
    .selectAll()
    .where("github_id", "=", fullPR.id)
    .executeTakeFirst();

  const existingLatestJson = await env.MACHINEN_BUCKET.get(latestR2Key);
  let oldPR: GitHubPullRequest | null = null;

  if (existingLatestJson) {
    const jsonText = await existingLatestJson.text();
    oldPR = await parsePRFromJson(jsonText);
  }

  const diff = generateDiff(
    oldPR as unknown as Record<string, unknown> | null,
    fullPR as unknown as Record<string, unknown>
  );
  const hasChanges = diff !== null && Object.keys(diff.changes).length > 0;

  const versionHash = `${fullPR.id}-${fullPR.updated_at}-${fullPR.body || ""}-${
    fullPR.title
  }-${fullPR.head.sha}`;
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

  const url = `https://github.com/${repoOwner}/${repoName}/pull/${prNumber}`;
  const json = prToJson(
    fullPR,
    {
      github_id: fullPR.id,
      number: fullPR.number,
      state: state,
      created_at: fullPR.created_at,
      updated_at: now,
      version_hash: versionHashStr,
    },
    comments,
    url
  );

  await env.MACHINEN_BUCKET.put(latestR2Key, JSON.stringify(json, null, 2));

  if (hasChanges && diff) {
    const historyR2Key = getHistoryR2Key(
      repoOwner,
      repoName,
      prNumber,
      diff.timestampForFilename
    );
    await env.MACHINEN_BUCKET.put(historyR2Key, JSON.stringify(diff, null, 2));
  }

  if (existingPR) {
    await db
      .updateTable("pull_requests")
      .set({
        title: fullPR.title,
        state: state,
        updated_at: now,
      })
      .where("github_id", "=", fullPR.id)
      .execute();
  } else {
    await db
      .insertInto("pull_requests")
      .values({
        github_id: fullPR.id,
        number: fullPR.number,
        title: fullPR.title,
        state: state,
        created_at: fullPR.created_at,
        updated_at: now,
      } as any)
      .execute();
  }
}
