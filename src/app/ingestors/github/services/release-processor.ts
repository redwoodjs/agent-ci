import { env } from "cloudflare:workers";
import { type Database, createDb } from "rwsdk/db";
import { type migrations } from "../db/migrations";
import { type GitHubRepoDurableObject } from "../db/durableObject";
import { releaseToMarkdown, type GitHubRelease } from "../utils/release-to-markdown";

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

async function generateVersionHash(release: GitHubRelease): Promise<string> {
  const content = `${release.id}-${release.published_at || release.created_at}-${release.body || ""}-${release.name || release.tag_name}`;
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
  tagName: string,
  versionHash: string
): string {
  return `github/${repoOwner}/${repoName}/releases/${tagName}/${versionHash}.md`;
}

export async function processReleaseEvent(
  release: GitHubRelease,
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

  const versionHash = await generateVersionHash(release);
  const r2Key = getR2Key(repoOwner, repoName, release.tag_name, versionHash);

  if (eventType === "deleted") {
    const existingRelease = await db
      .selectFrom("releases")
      .selectAll()
      .where("github_id", "=", release.id)
      .executeTakeFirst();

    if (existingRelease) {
      await db
        .updateTable("releases")
        .set({
          state: "deleted",
          updated_at: new Date().toISOString(),
        })
        .where("github_id", "=", release.id)
        .execute();
    }
    return;
  }

  const now = new Date().toISOString();
  let state: "draft" | "prerelease" | "published";
  if (eventType === "published" || eventType === "released") {
    state = "published";
  } else if (eventType === "prereleased") {
    state = "prerelease";
  } else {
    if (release.draft) {
      state = "draft";
    } else if (release.prerelease) {
      state = "prerelease";
    } else {
      state = "published";
    }
  }

  const existingRelease = await db
    .selectFrom("releases")
    .selectAll()
    .where("github_id", "=", release.id)
    .executeTakeFirst();

  const existingVersion = await db
    .selectFrom("release_versions")
    .selectAll()
    .where("r2_key", "=", r2Key)
    .executeTakeFirst();

  if (existingVersion) {
    if (existingRelease) {
      await db
        .updateTable("releases")
        .set({
          tag_name: release.tag_name,
          name: release.name,
          state: state,
          latest_version_id: existingVersion.id,
          updated_at: now,
        })
        .where("github_id", "=", release.id)
        .execute();
    }
    return;
  }

  if (existingRelease) {
    const versionResult = await db
      .insertInto("release_versions")
      .values({
        release_github_id: release.id,
        r2_key: r2Key,
        created_at: now,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .updateTable("releases")
      .set({
        tag_name: release.tag_name,
        name: release.name,
        state: state,
        latest_version_id: versionResult.id,
        updated_at: now,
      })
      .where("github_id", "=", release.id)
      .execute();
  } else {
    await db
      .insertInto("releases")
      .values({
        github_id: release.id,
        tag_name: release.tag_name,
        name: release.name,
        state: state,
        created_at: release.created_at,
        updated_at: now,
      } as any)
      .execute();

    const versionResult = await db
      .insertInto("release_versions")
      .values({
        release_github_id: release.id,
        r2_key: r2Key,
        created_at: now,
      } as any)
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .updateTable("releases")
      .set({
        latest_version_id: versionResult.id,
      })
      .where("github_id", "=", release.id)
      .execute();
  }

  const markdown = releaseToMarkdown(release, {
    github_id: release.id,
    tag_name: release.tag_name,
    state: state,
    created_at: release.created_at,
    updated_at: now,
    version_hash: versionHash,
  });

  const existingR2Object = await env.MACHINEN_BUCKET.head(r2Key);
  if (!existingR2Object) {
    await env.MACHINEN_BUCKET.put(r2Key, markdown);
  }
}

