import { env } from "cloudflare:workers";
import { type Database, createDb } from "rwsdk/db";
import { type backfillMigrations } from "../db/backfill-migrations";
import { type GitHubBackfillStateDO } from "../db/backfill-durableObject";
import type { BackfillStatus } from "./backfill-types";

type BackfillDatabase = Database<typeof backfillMigrations>;

declare module "rwsdk/worker" {
  interface WorkerEnv {
    GITHUB_BACKFILL_STATE: DurableObjectNamespace<GitHubBackfillStateDO>;
  }
}

export async function getBackfillState(
  repositoryKey: string
): Promise<{
  status: BackfillStatus;
  issues_cursor: string | null;
  pull_requests_cursor: string | null;
  comments_cursor: string | null;
  releases_cursor: string | null;
  projects_cursor: string | null;
  error_message: string | null;
  error_details: string | null;
} | null> {
  const db = createDb<BackfillDatabase>(
    (env as any).GITHUB_BACKFILL_STATE as DurableObjectNamespace<GitHubBackfillStateDO>,
    repositoryKey
  );

  const state = await db
    .selectFrom("backfill_state")
    .selectAll()
    .where("repository_key", "=", repositoryKey)
    .executeTakeFirst();

  if (!state) {
    return null;
  }

  return {
    status: state.status as BackfillStatus,
    issues_cursor: state.issues_cursor,
    pull_requests_cursor: state.pull_requests_cursor,
    comments_cursor: state.comments_cursor,
    releases_cursor: state.releases_cursor,
    projects_cursor: state.projects_cursor,
    error_message: state.error_message,
    error_details: state.error_details,
  };
}

export async function updateBackfillState(
  repositoryKey: string,
  updates: {
    status?: BackfillStatus;
    issues_cursor?: string | null;
    pull_requests_cursor?: string | null;
    comments_cursor?: string | null;
    releases_cursor?: string | null;
    projects_cursor?: string | null;
    error_message?: string | null;
    error_details?: string | null;
  }
): Promise<void> {
  const db = createDb<BackfillDatabase>(
    (env as any).GITHUB_BACKFILL_STATE as DurableObjectNamespace<GitHubBackfillStateDO>,
    repositoryKey
  );

  const now = new Date().toISOString();

  const existing = await db
    .selectFrom("backfill_state")
    .selectAll()
    .where("repository_key", "=", repositoryKey)
    .executeTakeFirst();

  if (existing) {
    await db
      .updateTable("backfill_state")
      .set({
        ...updates,
        updated_at: now,
      } as any)
      .where("repository_key", "=", repositoryKey)
      .execute();
  } else {
    await db
      .insertInto("backfill_state")
      .values({
        repository_key: repositoryKey,
        status: updates.status || "pending",
        issues_cursor: updates.issues_cursor ?? null,
        pull_requests_cursor: updates.pull_requests_cursor ?? null,
        comments_cursor: updates.comments_cursor ?? null,
        releases_cursor: updates.releases_cursor ?? null,
        projects_cursor: updates.projects_cursor ?? null,
        error_message: updates.error_message ?? null,
        error_details: updates.error_details ?? null,
        created_at: now,
        updated_at: now,
      } as any)
      .execute();
  }
}

