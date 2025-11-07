import { env } from "cloudflare:workers";
import { type Database, createDb } from "rwsdk/db";
import { type migrations } from "../db/migrations";
import { type GitHubRepoDurableObject } from "../db/durableObject";
import { releaseToMarkdown, type GitHubRelease } from "../utils/release-to-markdown";
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
  tagName: string
): string {
  return `github/${repoOwner}/${repoName}/releases/${tagName}/latest.md`;
}

function getHistoryR2Key(
  repoOwner: string,
  repoName: string,
  tagName: string,
  timestampForFilename: string
): string {
  return `github/${repoOwner}/${repoName}/releases/${tagName}/history/${timestampForFilename}.json`;
}

async function parseReleaseFromMarkdown(
  markdown: string
): Promise<GitHubRelease | null> {
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

    const bodyMatch = markdown.match(/^---\n[\s\S]*?\n---\n\n[\s\S]*?\n---\n\n([\s\S]*)$/);
    const body = bodyMatch ? bodyMatch[1].trim() : null;

    const titleMatch = markdown.match(/^#\s+(.+)$/m);
    const name = titleMatch ? titleMatch[1] : metadata.tag_name || "";

    const authorMatch = markdown.match(/\*\*Author:\*\*\s+@(\w+)/);
    const author = authorMatch ? authorMatch[1] : "";

    return {
      id: parseInt(metadata.github_id || "0", 10),
      tag_name: metadata.tag_name || "",
      name,
      body,
      draft: metadata.state === "draft",
      prerelease: metadata.state === "prerelease",
      created_at: metadata.created_at || "",
      published_at: metadata.state === "published" ? metadata.updated_at : null,
      author: { login: author },
    };
  } catch (e) {
    console.warn("[release-processor] Failed to parse release from markdown:", e);
    return null;
  }
}

export async function processReleaseEvent(
  partialRelease: GitHubRelease,
  eventType: "published" | "edited" | "deleted" | "prereleased" | "released",
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
    const existingRelease = await db
      .selectFrom("releases")
      .selectAll()
      .where("github_id", "=", partialRelease.id)
      .executeTakeFirst();

    if (existingRelease) {
      await db
        .updateTable("releases")
        .set({
          state: "deleted",
          updated_at: new Date().toISOString(),
        })
        .where("github_id", "=", partialRelease.id)
        .execute();
    }
    return;
  }

  const latestR2Key = getLatestR2Key(repoOwner, repoName, partialRelease.tag_name);

  let fullRelease: GitHubRelease;
  try {
    fullRelease = await fetchGitHubEntity<GitHubRelease>(
      `https://api.github.com/repos/${repoOwner}/${repoName}/releases/${partialRelease.id}`
    );
  } catch (error) {
    console.error(
      `[release-processor] Failed to fetch full release ${partialRelease.id}:`,
      error
    );
    throw error;
  }

  const now = new Date().toISOString();
  let state: "draft" | "prerelease" | "published";
  if (eventType === "published" || eventType === "released") {
    state = "published";
  } else if (eventType === "prereleased") {
    state = "prerelease";
  } else {
    if (fullRelease.draft) {
      state = "draft";
    } else if (fullRelease.prerelease) {
      state = "prerelease";
    } else {
      state = "published";
    }
  }

  const existingRelease = await db
    .selectFrom("releases")
    .selectAll()
    .where("github_id", "=", fullRelease.id)
    .executeTakeFirst();

  const existingLatestMd = await env.MACHINEN_BUCKET.get(latestR2Key);
  let oldRelease: GitHubRelease | null = null;

  if (existingLatestMd) {
    const markdown = await existingLatestMd.text();
    oldRelease = await parseReleaseFromMarkdown(markdown);
  }

  const diff = generateDiff(
    oldRelease as unknown as Record<string, unknown> | null,
    fullRelease as unknown as Record<string, unknown>
  );
  const hasChanges = diff !== null && Object.keys(diff.changes).length > 0;

  const versionHash = `${fullRelease.id}-${fullRelease.published_at || fullRelease.created_at}-${
    fullRelease.body || ""
  }-${fullRelease.name || fullRelease.tag_name}`;
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

  const markdown = releaseToMarkdown(fullRelease, {
    github_id: fullRelease.id,
    tag_name: fullRelease.tag_name,
    state: state,
    created_at: fullRelease.created_at,
    updated_at: now,
    version_hash: versionHashStr,
  });

  await env.MACHINEN_BUCKET.put(latestR2Key, markdown);

  if (hasChanges && diff) {
    const historyR2Key = getHistoryR2Key(
      repoOwner,
      repoName,
      fullRelease.tag_name,
      diff.timestampForFilename
    );
    await env.MACHINEN_BUCKET.put(historyR2Key, JSON.stringify(diff, null, 2));
  }

  if (existingRelease) {
    await db
      .updateTable("releases")
      .set({
        tag_name: fullRelease.tag_name,
        name: fullRelease.name,
        state: state,
        updated_at: now,
      })
      .where("github_id", "=", fullRelease.id)
      .execute();
  } else {
    await db
      .insertInto("releases")
      .values({
        github_id: fullRelease.id,
        tag_name: fullRelease.tag_name,
        name: fullRelease.name,
        state: state,
        created_at: fullRelease.created_at,
        updated_at: now,
      } as any)
      .execute();
  }
}

