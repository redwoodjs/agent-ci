import { env } from "cloudflare:workers";
import { type Database, createDb } from "rwsdk/db";
import { type migrations } from "../db/migrations";
import { type GitHubRepoDurableObject } from "../db/durableObject";
import {
  type GitHubProject,
  type ProjectItemWithTitle,
} from "../utils/project-to-markdown";
import {
  projectToJson,
  type ProjectLatestJson,
} from "../utils/project-to-json";
import {
  fetchGitHubProject,
  fetchProjectItems,
  fetchGitHubEntity,
  type GitHubProjectItem,
} from "../utils/github-api";
import { generateDiff } from "../utils/diff";
import type { GitHubIssue } from "../utils/issue-to-markdown";
import type { GitHubPullRequest } from "../utils/pr-to-markdown";

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
  projectIdentifier: string | number
): string {
  return `github/${repoOwner}/projects/${projectIdentifier}/latest.json`;
}

function getHistoryR2Key(
  repoOwner: string,
  projectIdentifier: string | number,
  timestampForFilename: string
): string {
  return `github/${repoOwner}/projects/${projectIdentifier}/history/${timestampForFilename}.json`;
}

async function parseProjectFromJson(
  jsonText: string
): Promise<GitHubProject | null> {
  try {
    const json = JSON.parse(jsonText) as ProjectLatestJson;
    return {
      id: json.github_id,
      number: json.number,
      title: json.title,
      body: json.body,
      state: json.state === "deleted" ? "closed" : json.state,
      created_at: json.created_at,
      updated_at: json.updated_at,
      owner: {
        login: json.owner,
        type: json.owner_type,
      },
    };
  } catch (e) {
    console.warn("[project-processor] Failed to parse project from JSON:", e);
    return null;
  }
}

export async function processProjectEvent(
  partialProject: GitHubProject,
  eventType: "created" | "edited" | "closed" | "reopened" | "deleted",
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
    const existingProject = await db
      .selectFrom("projects")
      .selectAll()
      .where("github_id", "=", partialProject.id)
      .executeTakeFirst();

    if (existingProject) {
      await db
        .updateTable("projects")
        .set({
          state: "deleted",
          updated_at: new Date().toISOString(),
        })
        .where("github_id", "=", partialProject.id)
        .execute();
    }
    return;
  }

  let graphQLProject;
  try {
    graphQLProject = await fetchGitHubProject(partialProject.id);
  } catch (error) {
    console.error(
      `[project-processor] Failed to fetch full project ${partialProject.id}:`,
      error
    );
    throw error;
  }

  const fullProject: GitHubProject = {
    id: graphQLProject.id,
    number: graphQLProject.number,
    title: graphQLProject.title,
    body: graphQLProject.shortDescription,
    state: graphQLProject.closed ? "closed" : "open",
    created_at: graphQLProject.createdAt,
    updated_at: graphQLProject.updatedAt,
    owner: graphQLProject.owner,
  };

  const projectIdentifier = fullProject.number || fullProject.id;
  const latestR2Key = getLatestR2Key(repoOwner, projectIdentifier);

  let itemsWithTitles: ProjectItemWithTitle[] = [];
  try {
    const items = await fetchProjectItems(fullProject.id);
    itemsWithTitles = items.map((item) => {
      return {
        id: item.id,
        content_id: item.content_id,
        content_type: item.content_type,
        title: undefined,
        field_values: item.field_values?.map((fv) => ({
          name: fv.name,
          value: fv.value,
        })),
      };
    });
  } catch (error) {
    console.warn(
      `[project-processor] Failed to fetch project items for project ${projectIdentifier}:`,
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
    state = fullProject.state === "closed" ? "closed" : "open";
  }

  const existingProject = await db
    .selectFrom("projects")
    .selectAll()
    .where("github_id", "=", fullProject.id)
    .executeTakeFirst();

  const existingLatestJson = await env.MACHINEN_BUCKET.get(latestR2Key);
  let oldProject: GitHubProject | null = null;

  if (existingLatestJson) {
    const jsonText = await existingLatestJson.text();
    oldProject = await parseProjectFromJson(jsonText);
  }

  const diff = generateDiff(
    oldProject as unknown as Record<string, unknown> | null,
    fullProject as unknown as Record<string, unknown>
  );
  const hasChanges = diff !== null && Object.keys(diff.changes).length > 0;

  const versionHash = `${fullProject.id}-${fullProject.updated_at}-${
    fullProject.body || ""
  }-${fullProject.title}`;
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

  const json = projectToJson(
    fullProject,
    {
      github_id: fullProject.id,
      state: state,
      created_at: fullProject.created_at,
      updated_at: now,
      version_hash: versionHashStr,
    },
    itemsWithTitles
  );

  await env.MACHINEN_BUCKET.put(
    latestR2Key,
    JSON.stringify(json, null, 2)
  );

  if (hasChanges && diff) {
    const historyR2Key = getHistoryR2Key(
      repoOwner,
      projectIdentifier,
      diff.timestampForFilename
    );
    await env.MACHINEN_BUCKET.put(historyR2Key, JSON.stringify(diff, null, 2));
  }

  if (existingProject) {
    await db
      .updateTable("projects")
      .set({
        title: fullProject.title,
        body: fullProject.body,
        state: state,
        updated_at: now,
      })
      .where("github_id", "=", fullProject.id)
      .execute();
  } else {
    await db
      .insertInto("projects")
      .values({
        github_id: fullProject.id,
        title: fullProject.title,
        body: fullProject.body,
        state: state,
        created_at: fullProject.created_at,
        updated_at: now,
      } as any)
      .execute();
  }
}

