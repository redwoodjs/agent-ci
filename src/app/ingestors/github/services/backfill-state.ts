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

export async function getBackfillState(repositoryKey: string): Promise<{
  status: BackfillStatus;
  issues_cursor: string | null;
  pull_requests_cursor: string | null;
  comments_cursor: string | null;
  releases_cursor: string | null;
  projects_cursor: string | null;
  error_message: string | null;
  error_details: string | null;
  test_run: boolean;
  current_run_id: string | null;
  moment_graph_namespace_prefix: string | null;
  enqueued_count: number;
  processed_count: number;
  enqueue_completed: boolean;
  processed_completed: boolean;
  processed_completed_at: string | null;
} | null> {
  const db = createDb<BackfillDatabase>(
    (env as any)
      .GITHUB_BACKFILL_STATE as DurableObjectNamespace<GitHubBackfillStateDO>,
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
    test_run: (state as any).test_run === 1,
    current_run_id: (state as any).current_run_id ?? null,
    moment_graph_namespace_prefix:
      (state as any).moment_graph_namespace_prefix ?? null,
    enqueued_count: Number((state as any).enqueued_count ?? 0),
    processed_count: Number((state as any).processed_count ?? 0),
    enqueue_completed: Number((state as any).enqueue_completed ?? 0) === 1,
    processed_completed: Number((state as any).processed_completed ?? 0) === 1,
    processed_completed_at: (state as any).processed_completed_at ?? null,
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
    test_run?: boolean;
    current_run_id?: string | null;
    moment_graph_namespace_prefix?: string | null;
    enqueued_count?: number;
    processed_count?: number;
    enqueue_completed?: boolean;
    processed_completed?: boolean;
    processed_completed_at?: string | null;
  }
): Promise<void> {
  const db = createDb<BackfillDatabase>(
    (env as any)
      .GITHUB_BACKFILL_STATE as DurableObjectNamespace<GitHubBackfillStateDO>,
    repositoryKey
  );

  const now = new Date().toISOString();

  const existing = await db
    .selectFrom("backfill_state")
    .selectAll()
    .where("repository_key", "=", repositoryKey)
    .executeTakeFirst();

  const updateValues: any = {
    ...updates,
    updated_at: now,
  };

  if (updates.test_run !== undefined) {
    updateValues.test_run = updates.test_run ? 1 : 0;
  }
  if (updates.enqueue_completed !== undefined) {
    updateValues.enqueue_completed = updates.enqueue_completed ? 1 : 0;
  }
  if (updates.processed_completed !== undefined) {
    updateValues.processed_completed = updates.processed_completed ? 1 : 0;
  }

  if (existing) {
    await db
      .updateTable("backfill_state")
      .set(updateValues)
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
        test_run: updates.test_run ? 1 : 0,
        current_run_id: updates.current_run_id ?? null,
        moment_graph_namespace_prefix:
          updates.moment_graph_namespace_prefix ?? null,
        enqueued_count: updates.enqueued_count ?? 0,
        processed_count: updates.processed_count ?? 0,
        enqueue_completed: updates.enqueue_completed ? 1 : 0,
        processed_completed: updates.processed_completed ? 1 : 0,
        processed_completed_at: updates.processed_completed_at ?? null,
        created_at: now,
        updated_at: now,
      } as any)
      .execute();
  }
}

export async function incrementBackfillEnqueuedCount(
  repositoryKey: string,
  runId: string,
  delta: number
): Promise<void> {
  if (!Number.isFinite(delta) || delta <= 0) {
    return;
  }

  const state = await getBackfillState(repositoryKey);
  if (!state || state.current_run_id !== runId) {
    return;
  }

  await updateBackfillState(repositoryKey, {
    enqueued_count: state.enqueued_count + delta,
  });
}

export async function markBackfillEnqueueCompleted(
  repositoryKey: string,
  runId: string
): Promise<void> {
  const state = await getBackfillState(repositoryKey);
  if (!state || state.current_run_id !== runId) {
    return;
  }

  await updateBackfillState(repositoryKey, {
    enqueue_completed: true,
  });
}

export async function incrementBackfillProcessedCountAndMaybeComplete(
  repositoryKey: string,
  runId: string
): Promise<{
  shouldLogCompletion: boolean;
  enqueuedCount: number;
  processedCount: number;
  momentGraphNamespacePrefix: string | null;
} | null> {
  const db = createDb<BackfillDatabase>(
    (env as any)
      .GITHUB_BACKFILL_STATE as DurableObjectNamespace<GitHubBackfillStateDO>,
    repositoryKey
  );

  const existing = await db
    .selectFrom("backfill_state")
    .selectAll()
    .where("repository_key", "=", repositoryKey)
    .executeTakeFirst();

  if (!existing || (existing as any).current_run_id !== runId) {
    return null;
  }

  const currentProcessed = Number((existing as any).processed_count ?? 0);
  const nextProcessed = currentProcessed + 1;
  const enqueuedCount = Number((existing as any).enqueued_count ?? 0);
  const enqueueCompleted =
    Number((existing as any).enqueue_completed ?? 0) === 1;
  const processedCompleted =
    Number((existing as any).processed_completed ?? 0) === 1;

  await db
    .updateTable("backfill_state")
    .set({
      processed_count: nextProcessed as any,
      updated_at: new Date().toISOString(),
    })
    .where("repository_key", "=", repositoryKey)
    .execute();

  if (
    !enqueueCompleted ||
    processedCompleted ||
    nextProcessed < enqueuedCount
  ) {
    return {
      shouldLogCompletion: false,
      enqueuedCount,
      processedCount: nextProcessed,
      momentGraphNamespacePrefix:
        (existing as any).moment_graph_namespace_prefix ?? null,
    };
  }

  const processedCompletedAt = new Date().toISOString();

  const completionResult = await db
    .updateTable("backfill_state")
    .set({
      processed_completed: 1 as any,
      processed_completed_at: processedCompletedAt as any,
      updated_at: processedCompletedAt as any,
    })
    .where("repository_key", "=", repositoryKey)
    .where("current_run_id", "=", runId as any)
    .where("processed_completed", "=", 0 as any)
    .execute();

  const updatedRows =
    typeof (completionResult as any).numUpdatedRows === "bigint"
      ? Number((completionResult as any).numUpdatedRows)
      : Number((completionResult as any).numUpdatedRows ?? 0);

  return {
    shouldLogCompletion: updatedRows > 0,
    enqueuedCount,
    processedCount: nextProcessed,
    momentGraphNamespacePrefix:
      (existing as any).moment_graph_namespace_prefix ?? null,
  };
}
