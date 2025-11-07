import { env } from "cloudflare:workers";
import { type Database, createDb } from "rwsdk/db";
import { type migrations } from "../db/migrations";
import { type GitHubRepoDurableObject } from "../db/durableObject";
import { issueToMarkdown, type GitHubIssue } from "../utils/issue-to-markdown";
import { fetchGitHubEntity } from "../utils/github-api";
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
  return `github/${repoOwner}/${repoName}/issues/${issueNumber}/latest.md`;
}

function getHistoryR2Key(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  timestamp: string
): string {
  const timestampStr = timestamp.replace(/[:.]/g, "-");
  return `github/${repoOwner}/${repoName}/issues/${issueNumber}/history/${timestampStr}.json`;
}

async function parseIssueFromMarkdown(
  markdown: string
): Promise<GitHubIssue | null> {
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

    return {
      id: parseInt(metadata.github_id || "0", 10),
      number: parseInt(metadata.number || "0", 10),
      title,
      body,
      state: (metadata.state as "open" | "closed") || "open",
      created_at: metadata.created_at || "",
      updated_at: metadata.updated_at || "",
      user: { login: "" },
    };
  } catch (e) {
    console.warn("[issue-processor] Failed to parse issue from markdown:", e);
    return null;
  }
}

export async function processIssueEvent(
  partialIssue: GitHubIssue,
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

  const existingLatestMd = await env.MACHINEN_BUCKET.get(latestR2Key);
  let oldIssue: GitHubIssue | null = null;

  if (existingLatestMd) {
    const markdown = await existingLatestMd.text();
    oldIssue = await parseIssueFromMarkdown(markdown);
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

  const markdown = issueToMarkdown(fullIssue, {
    github_id: fullIssue.id,
    number: fullIssue.number,
    state: state,
    created_at: fullIssue.created_at,
    updated_at: now,
    version_hash: versionHashStr,
  });

  await env.MACHINEN_BUCKET.put(latestR2Key, markdown);

  if (hasChanges && diff) {
    const historyR2Key = getHistoryR2Key(
      repoOwner,
      repoName,
      issueNumber,
      diff.timestamp
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
