import { env } from "cloudflare:workers";
import { type Database, createDb } from "rwsdk/db";
import { type migrations } from "../db/migrations";
import { type GitHubRepoDurableObject } from "../db/durableObject";
import { prToMarkdown, type GitHubPullRequest } from "../utils/pr-to-markdown";
import { fetchGitHubEntity } from "../utils/github-api";
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
  return `github/${repoOwner}/${repoName}/pull-requests/${prNumber}/latest.md`;
}

function getHistoryR2Key(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  timestampForFilename: string
): string {
  return `github/${repoOwner}/${repoName}/pull-requests/${prNumber}/history/${timestampForFilename}.json`;
}

async function parsePRFromMarkdown(
  markdown: string
): Promise<GitHubPullRequest | null> {
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

    const bodyMatch = markdown.match(/^---\n[\s\S]*?\n---\n\n([\s\S]*)$/);
    const body = bodyMatch ? bodyMatch[1].trim() : null;

    const titleMatch = markdown.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1] : "";

    const baseMatch = markdown.match(/\*\*Base:\*\*\s+(\w+)\s+\(([a-f0-9]+)\)/);
    const headMatch = markdown.match(/\*\*Head:\*\*\s+(\w+)\s+\(([a-f0-9]+)\)/);

    return {
      id: parseInt(metadata.github_id || "0", 10),
      number: parseInt(metadata.number || "0", 10),
      title,
      body,
      state: (metadata.state as "open" | "closed") || "open",
      merged: metadata.state === "merged",
      created_at: metadata.created_at || "",
      updated_at: metadata.updated_at || "",
      user: { login: "" },
      base: {
        ref: baseMatch ? baseMatch[1] : "",
        sha: baseMatch ? baseMatch[2] : "",
      },
      head: {
        ref: headMatch ? headMatch[1] : "",
        sha: headMatch ? headMatch[2] : "",
      },
    };
  } catch (e) {
    console.warn("[pr-processor] Failed to parse PR from markdown:", e);
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

  const existingLatestMd = await env.MACHINEN_BUCKET.get(latestR2Key);
  let oldPR: GitHubPullRequest | null = null;

  if (existingLatestMd) {
    const markdown = await existingLatestMd.text();
    oldPR = await parsePRFromMarkdown(markdown);
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

  const markdown = prToMarkdown(fullPR, {
    github_id: fullPR.id,
    number: fullPR.number,
    state: state,
    created_at: fullPR.created_at,
    updated_at: now,
    version_hash: versionHashStr,
  });

  await env.MACHINEN_BUCKET.put(latestR2Key, markdown);

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
