import { env } from "cloudflare:workers";
import { type Database, createDb } from "rwsdk/db";
import { type migrations } from "../db/migrations";
import { type GitHubRepoDurableObject } from "../db/durableObject";
import {
  commentToMarkdown,
  type GitHubComment,
} from "../utils/comment-to-markdown";
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
  parentType: "issues" | "pull-requests",
  parentNumber: number,
  commentId: number
): string {
  return `github/${repoOwner}/${repoName}/${parentType}/${parentNumber}/comments/${commentId}/latest.md`;
}

function getHistoryR2Key(
  repoOwner: string,
  repoName: string,
  parentType: "issues" | "pull-requests",
  parentNumber: number,
  commentId: number,
  timestampForFilename: string
): string {
  return `github/${repoOwner}/${repoName}/${parentType}/${parentNumber}/comments/${commentId}/history/${timestampForFilename}.json`;
}

async function parseCommentFromMarkdown(
  markdown: string
): Promise<GitHubComment | null> {
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

    const bodyMatch = markdown.match(
      /^---\n[\s\S]*?\n---\n\n[\s\S]*?\n---\n\n([\s\S]*)$/
    );
    const body = bodyMatch ? bodyMatch[1].trim() : "";

    const authorMatch = markdown.match(/\*\*Author:\*\*\s+@(\w+)/);
    const author = authorMatch ? authorMatch[1] : "";

    return {
      id: parseInt(metadata.github_id || "0", 10),
      body,
      created_at: metadata.created_at || "",
      updated_at: metadata.updated_at || "",
      user: { login: author },
    };
  } catch (e) {
    console.warn(
      "[comment-processor] Failed to parse comment from markdown:",
      e
    );
    return null;
  }
}

export async function processCommentEvent(
  partialComment: GitHubComment,
  eventType: "created" | "edited" | "deleted",
  repository: { owner: { login: string }; name: string },
  issueId?: number,
  pullRequestId?: number,
  reviewId?: number
): Promise<void> {
  const repoOwner = repository.owner.login;
  const repoName = repository.name;
  const repoKey = getRepositoryKey(repoOwner, repoName);
  const db = createDb<GitHubDatabase>(
    (env as any).GITHUB_REPO as DurableObjectNamespace<GitHubRepoDurableObject>,
    repoKey
  );

  const parentType = issueId ? "issues" : "pull-requests";
  const parentNumber = issueId || pullRequestId || 0;
  if (!parentNumber) {
    throw new Error(
      `Comment ${partialComment.id} has no parent issue or pull request`
    );
  }

  if (eventType === "deleted") {
    const existingComment = await db
      .selectFrom("comments")
      .selectAll()
      .where("github_id", "=", partialComment.id)
      .executeTakeFirst();

    if (existingComment) {
      await db
        .updateTable("comments")
        .set({
          updated_at: new Date().toISOString(),
        })
        .where("github_id", "=", partialComment.id)
        .execute();
    }
    return;
  }

  const latestR2Key = getLatestR2Key(
    repoOwner,
    repoName,
    parentType,
    parentNumber,
    partialComment.id
  );

  let fullComment: GitHubComment;
  try {
    fullComment = await fetchGitHubEntity<GitHubComment>(
      `https://api.github.com/repos/${repoOwner}/${repoName}/issues/comments/${partialComment.id}`
    );
  } catch (error) {
    console.error(
      `[comment-processor] Failed to fetch full comment ${partialComment.id}:`,
      error
    );
    throw error;
  }

  const now = new Date().toISOString();

  const existingComment = await db
    .selectFrom("comments")
    .selectAll()
    .where("github_id", "=", fullComment.id)
    .executeTakeFirst();

  const existingLatestMd = await env.MACHINEN_BUCKET.get(latestR2Key);
  let oldComment: GitHubComment | null = null;

  if (existingLatestMd) {
    const markdown = await existingLatestMd.text();
    oldComment = await parseCommentFromMarkdown(markdown);
  }

  const diff = generateDiff(
    oldComment as unknown as Record<string, unknown> | null,
    fullComment as unknown as Record<string, unknown>
  );
  const hasChanges = diff !== null && Object.keys(diff.changes).length > 0;

  const versionHash = `${fullComment.id}-${fullComment.updated_at}-${fullComment.body}`;
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

  const markdown = commentToMarkdown(fullComment, {
    github_id: fullComment.id,
    issue_id: issueId,
    pull_request_id: pullRequestId,
    review_id: reviewId || fullComment.pull_request_review_id,
    created_at: fullComment.created_at,
    updated_at: now,
    version_hash: versionHashStr,
  });

  await env.MACHINEN_BUCKET.put(latestR2Key, markdown);

  if (hasChanges && diff) {
    const historyR2Key = getHistoryR2Key(
      repoOwner,
      repoName,
      parentType,
      parentNumber,
      fullComment.id,
      diff.timestampForFilename
    );
    await env.MACHINEN_BUCKET.put(historyR2Key, JSON.stringify(diff, null, 2));
  }

  if (existingComment) {
    await db
      .updateTable("comments")
      .set({
        updated_at: now,
      })
      .where("github_id", "=", fullComment.id)
      .execute();
  } else {
    await db
      .insertInto("comments")
      .values({
        github_id: fullComment.id,
        issue_id: issueId || null,
        pull_request_id: pullRequestId || null,
        review_id: reviewId || fullComment.pull_request_review_id || null,
        created_at: fullComment.created_at,
        updated_at: now,
      } as any)
      .execute();
  }
}
