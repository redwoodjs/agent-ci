import { env } from "cloudflare:workers";
import { type Database, createDb } from "rwsdk/db";
import { type migrations } from "../db/migrations";
import { type GitHubRepoDurableObject } from "../db/durableObject";
import { commentToMarkdown, type GitHubComment } from "../utils/comment-to-markdown";

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

async function generateVersionHash(comment: GitHubComment): Promise<string> {
  const content = `${comment.id}-${comment.updated_at}-${comment.body}`;
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
  parentType: "issues" | "pull-requests",
  parentNumber: number,
  commentId: number,
  versionHash: string
): string {
  return `github-ingest/${repoOwner}/${repoName}/${parentType}/${parentNumber}/comments/${commentId}/${versionHash}.md`;
}

export async function processCommentEvent(
  comment: GitHubComment,
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

  const versionHash = await generateVersionHash(comment);
  const parentType = issueId ? "issues" : "pull-requests";
  const parentNumber = issueId
    ? comment.issue?.number || 0
    : comment.pull_request?.number || 0;
  const r2Key = getR2Key(
    repoOwner,
    repoName,
    parentType,
    parentNumber,
    comment.id,
    versionHash
  );

  if (eventType === "deleted") {
    const existingComment = await db
      .selectFrom("comments")
      .selectAll()
      .where("github_id", "=", comment.id)
      .executeTakeFirst();

    if (existingComment) {
      await db
        .updateTable("comments")
        .set({
          updated_at: new Date().toISOString(),
        })
        .where("github_id", "=", comment.id)
        .execute();
    }
    return;
  }

  const now = new Date().toISOString();

  const existingComment = await db
    .selectFrom("comments")
    .selectAll()
    .where("github_id", "=", comment.id)
    .executeTakeFirst();

  if (existingComment) {
    const versionResult = await db
      .insertInto("comment_versions")
      .values({
        comment_github_id: comment.id,
        r2_key: r2Key,
        created_at: now,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .updateTable("comments")
      .set({
        latest_version_id: versionResult.id,
        updated_at: now,
      })
      .where("github_id", "=", comment.id)
      .execute();
  } else {
    await db
      .insertInto("comments")
      .values({
        github_id: comment.id,
        issue_id: issueId || null,
        pull_request_id: pullRequestId || null,
        review_id: reviewId || null,
        created_at: comment.created_at,
        updated_at: now,
      } as any)
      .execute();

    const versionResult = await db
      .insertInto("comment_versions")
      .values({
        comment_github_id: comment.id,
        r2_key: r2Key,
        created_at: now,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .updateTable("comments")
      .set({
        latest_version_id: versionResult.id,
      })
      .where("github_id", "=", comment.id)
      .execute();
  }

  const markdown = commentToMarkdown(comment, {
    github_id: comment.id,
    issue_id: issueId,
    pull_request_id: pullRequestId,
    review_id: reviewId || comment.pull_request_review_id,
    created_at: comment.created_at,
    updated_at: now,
    version_hash: versionHash,
  });

  await env.MACHINEN_BUCKET.put(r2Key, markdown);
}

