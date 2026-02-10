import { getSimulationDb } from "../../simulation/db";
import { addSimulationRunEvent } from "../../simulation/runEvents";
import { getPhaseByName } from "../../../pipelines/registry";
import { sql } from "rwsdk/db";
import {
  SimulationDbContext,
  simulationPhases,
  SimulationRunRow,
  SimulationRunR2BatchRow,
  SimulationRunDocumentRow,
} from "../../simulation/types";
import { normalizePhase } from "../../simulation/runs";

// No longer need hardcoded phaseRunners mapping here

export async function tickSimulationRun(
  context: SimulationDbContext,
  input: { runId: string; continueOnError?: boolean },
): Promise<{ status: string; currentPhase: string } | null> {
  const db = getSimulationDb(context);
  const runId =
    typeof input.runId === "string" && input.runId.trim().length > 0
      ? input.runId.trim()
      : "";
  if (!runId) {
    return null;
  }

  const row = (await db
    .selectFrom("simulation_runs")
    .select(["status", "current_phase", "updated_at"])
    .where("run_id", "=", runId)
    .executeTakeFirst()) as unknown as
    | SimulationRunRow
    | undefined;

  if (!row) {
    return null;
  }

  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const isStaleLock =
    row.status === "busy_running" && row.updated_at < fiveMinutesAgo;

  if (
    row.status !== "running" &&
    row.status !== "awaiting_documents" &&
    row.status !== "advance" &&
    row.status !== "settling" &&
    !isStaleLock
  ) {
    return { status: row.status, currentPhase: row.current_phase };
  }

  // Atomically set status to busy_running to prevent concurrent advancement
  // We allow breaking a "busy_running" lock if it hasn't been updated for more than 5 minutes
  const now = new Date().toISOString();

  await db
    .updateTable("simulation_runs")
    .set({
      status: "busy_running",
      updated_at: now,
    } as any)
    .where("run_id", "=", runId)
    .where((eb) =>
      eb.or([
        eb("status", "in", ["running", "awaiting_documents", "settling", "advance"]),
        eb.and([
          eb("status", "=", "busy_running"),
          eb("updated_at", "<", fiveMinutesAgo),
        ]),
      ]),
    )
    .execute();

  if (isStaleLock) {
    console.warn(
      `[runner] Breaking stale busy_running lock for run ${runId} (last updated ${row.updated_at})`,
    );
    await addSimulationRunEvent(context, {
      runId,
      level: "warn",
      kind: "host.lock_broken",
      payload: { status: row.status, lastUpdatedAt: row.updated_at },
    });
  }

  // Verify we actually got the lock
  const refreshed = (await db
    .selectFrom("simulation_runs")
    .select(["status"])
    .where("run_id", "=", runId)
    .executeTakeFirst()) as SimulationRunRow | undefined;

  if (refreshed?.status !== "busy_running") {
    return {
      status: refreshed?.status ?? row.status,
      currentPhase: row.current_phase,
    };
  }

  const phase = normalizePhase(row.current_phase);
  const phaseIdx = simulationPhases.indexOf(phase);

  await addSimulationRunEvent(context, {
    runId,
    level: "debug",
    kind: "host.phase.tick",
    payload: { runId, phase, phaseIdx },
  });

  try {
    let result: { status: string; currentPhase: string } | null = null;
    let finalStatus: string = "running";
    let currentPhase: string = phase;

    if (row.status === "settling") {
      finalStatus = "completed";
    } else if (phase === "r2_listing") {
      result = await tickR2Listing(context, { runId });
    } else {
      const phaseDef = getPhaseByName(phase);
      if (!phaseDef) {
        throw new Error(`No definition found for phase: ${phase}`);
      }
      
      // Supervisor Check: Sweep for zombies
      await recoverPhaseZombies(context, { runId, phase });

      // Supervisor Tick: Generic Document Polling
      result = await tickGenericDocumentPolling(context, { runId, phase });
    }

    finalStatus = result?.status ?? finalStatus;
    currentPhase = result?.currentPhase ?? currentPhase;

    await addSimulationRunEvent(context, {
      runId,
      level: "debug",
      kind: "host.phase.transition",
      payload: {
        phase,
        status: finalStatus,
        nextPhase:
          finalStatus === "advance"
            ? (simulationPhases[phaseIdx + 1] ?? "completed")
            : currentPhase,
      },
    });

    // Move to next phase if we're advancing, otherwise we're done
    if (finalStatus === "advance") {
      const nextIdx = phaseIdx + 1;
      if (nextIdx < simulationPhases.length) {
        currentPhase = simulationPhases[nextIdx];
        finalStatus = "running";
        console.log(
          `[runner] Advancing run ${runId} from ${phase} to ${currentPhase}`,
        );
      } else {
        finalStatus = "settling";
        console.log(`[runner] Run ${runId} completed all phases, settling events...`);
      }
    }

    if (finalStatus === "busy_running") {
      finalStatus = "running";
    }

    // ... existing paused_on_error check ...
    if (finalStatus === "paused_on_error" && input.continueOnError) {
      const nextPhase = simulationPhases[phaseIdx + 1] ?? null;
      if (nextPhase) {
        if ((context.env as any).ENGINE_INDEXING_QUEUE) {
          await (context.env as any).ENGINE_INDEXING_QUEUE.send({
            jobType: "simulation-advance",
            runId,
          });
          return { status: "running", currentPhase: nextPhase };
        }
        await db
          .updateTable("simulation_runs")
          .set({
            status: "running",
            current_phase: nextPhase,
            updated_at: new Date().toISOString(),
          } as any)
          .where("run_id", "=", runId)
          .execute();
        return { status: "running", currentPhase: nextPhase };
      }
    }

    if (
      (finalStatus === "running" || finalStatus === "settling") &&
      (context.env as any).ENGINE_INDEXING_QUEUE
    ) {
      await (context.env as any).ENGINE_INDEXING_QUEUE.send({
        jobType: "simulation-advance",
        runId,
      });
    }

    // Set the status explicitly (clearing busy_running)
    await db
      .updateTable("simulation_runs")
      .set({
        status: finalStatus,
        current_phase: currentPhase,
        updated_at: new Date().toISOString(),
      } as any)
      .where("run_id", "=", runId)
      .execute();

    return { ...result, status: finalStatus, currentPhase };
  } catch (error: any) {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    console.error(`[runner] Crash in phase ${phase}: ${msg}`, stack);

    await addSimulationRunEvent(context, {
      runId,
      level: "error",
      kind: "phase.error",
      payload: { phase, error: msg, stack },
    });

    const now = new Date().toISOString();

    if (input.continueOnError) {
      const loggerPayload = {
        message: `Crashed in ${phase}: ${msg}`,
        phase,
        recovered: true,
      };

      await db
        .updateTable("simulation_runs")
        .set({
          status: "running",
          updated_at: now,
          last_error_json: JSON.stringify(loggerPayload),
        } as any)
        .where("run_id", "=", runId)
        .execute();

      // Rethrow to trigger Cloudflare Queue native retry/DLQ
      throw new Error(`Simulation phase ${phase} failed: ${msg}`);
    }

    await db
      .updateTable("simulation_runs")
      .set({
        status: "paused_on_error",
        updated_at: now,
        last_progress_at: now,
        last_error_json: JSON.stringify({
          message: msg,
          phase,
          stack,
        }),
      } as any)
      .where("run_id", "=", runId)
      .execute();

    return { status: "paused_on_error", currentPhase: phase };
  } finally {
    // Ultimate safety: if we are still 'busy_running' (e.g. catch block failed to update DB)
    // we MUST reset to 'running' to let history continue.
    const finalCheck = await db
      .selectFrom("simulation_runs")
      .select("status")
      .where("run_id", "=", runId)
      .executeTakeFirst();

    if (finalCheck?.status === "busy_running") {
      await db
        .updateTable("simulation_runs")
        .set({ status: "running", updated_at: new Date().toISOString() })
        .where("run_id", "=", runId)
        .execute();
    }
  }
}

export async function autoAdvanceSimulationRun(
  context: SimulationDbContext,
  input: { runId: string; maxMs?: number; continueOnError?: boolean },
): Promise<{ status: string; currentPhase: string; steps: number }> {
  const startedAt = Date.now();
  const maxMs = input.maxMs ?? 25000; // Default 25s for Cloudflare worker limits (30s max)
  const continueOnError = input.continueOnError ?? true;
  let steps = 0;
  let lastResult: { status: string; currentPhase: string } | null = null;

  while (Date.now() - startedAt < maxMs) {
    const res = await tickSimulationRun(context, {
      runId: input.runId,
      continueOnError,
    });
    if (!res) {
      break;
    }
    lastResult = res;
    steps++;



    if (res.status !== "running") {
      break;
    }
  }

  if (!lastResult) {
    const db = getSimulationDb(context);
    const row = (await db
      .selectFrom("simulation_runs")
      .select(["status", "current_phase"])
      .where("run_id", "=", input.runId)
      .executeTakeFirst()) as
      | { status: string; current_phase: string }
      | undefined;
    return {
      status: row?.status ?? "unknown",
      currentPhase: row?.current_phase ?? "unknown",
      steps,
    };
  }

  return { ...lastResult, steps };
}

async function tickR2Listing(
  context: SimulationDbContext,
  input: { runId: string }
): Promise<{ status: string; currentPhase: string } | null> {
  const db = getSimulationDb(context);
  const now = new Date().toISOString();

  const runRow = await db
    .selectFrom("simulation_runs")
    .select(["config_json"])
    .where("run_id", "=", input.runId)
    .executeTakeFirst();

  if (!runRow) return null;

  const config = (runRow.config_json as any) || {};
  const r2ListConfig = config.r2List;

  // Upfront keys support
  if (Array.isArray(config.r2Keys) && config.r2Keys.length > 0) {
    const keys = config.r2Keys as string[];
    const chunkSize = 1000;
    for (let i = 0; i < keys.length; i += chunkSize) {
      const chunk = keys.slice(i, i + chunkSize);
      const batchIndex = Math.floor(i / chunkSize);
      await db
        .insertInto("simulation_run_r2_batches")
        .values({
          run_id: input.runId,
          batch_index: batchIndex,
          keys_json: JSON.stringify(chunk),
          processed: 0,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.columns(["run_id", "batch_index"]).doUpdateSet({
            keys_json: JSON.stringify(chunk),
            updated_at: now,
          })
        )
        .execute();
    }

    await addSimulationRunEvent(context, {
      runId: input.runId,
      level: "info",
      kind: "phase.r2_keys_prepopulated",
      payload: { count: keys.length },
    });

    return { status: "advance", currentPhase: "r2_listing" };
  }

  if (!r2ListConfig) {
    return { status: "advance", currentPhase: "r2_listing" };
  }

  const bucket = (context.env as any).MACHINEN_BUCKET as R2Bucket;
  if (!bucket) throw new Error("MACHINEN_BUCKET not found in env");

  if (typeof r2ListConfig.currentPrefixIdx !== "number") {
    r2ListConfig.currentPrefixIdx = 0;
    r2ListConfig.pagesProcessed = 0;
    r2ListConfig.prefixPagesProcessed = 0;
  }

  const prefixes = Array.isArray(r2ListConfig.targetPrefixes)
    ? r2ListConfig.targetPrefixes
    : [];
  const limit = r2ListConfig.limitPerPage || 1000;
  const maxPages = r2ListConfig.maxPages || 1000;

  if (
    r2ListConfig.currentPrefixIdx >= prefixes.length ||
    r2ListConfig.pagesProcessed >= maxPages
  ) {
    return { status: "advance", currentPhase: "r2_listing" };
  }

  const currentPrefix = prefixes[r2ListConfig.currentPrefixIdx];
  const cursor = r2ListConfig.cursor;

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: "info",
    kind: "phase.r2_list_page",
    payload: { prefix: currentPrefix, cursor },
  });

  const listOpts: R2ListOptions = {
    prefix: currentPrefix,
    limit,
    cursor,
  };

  const result = await bucket.list(listOpts);
  const keys = result.objects.map((o) => o.key).filter((k) => !!k);

  // Filtering logic
  const validKeys = keys.filter((k) => {
    const isGithubIssue =
      k.startsWith("github/") &&
      (!r2ListConfig.githubRepo ||
        k.startsWith(`github/${r2ListConfig.githubRepo}/`)) &&
      k.includes("/issues/") &&
      k.endsWith("/latest.json");
    const isGithubPr =
      k.startsWith("github/") &&
      (!r2ListConfig.githubRepo ||
        k.startsWith(`github/${r2ListConfig.githubRepo}/`)) &&
      k.includes("/pull-requests/") &&
      k.endsWith("/latest.json");
    const isDiscord = k.startsWith("discord/");
    const isCursor = k.startsWith("cursor/conversations/");

    return isGithubIssue || isGithubPr || isDiscord || isCursor;
  });

  if (validKeys.length > 0) {
    const batchIndex = r2ListConfig.pagesProcessed;
    await db
      .insertInto("simulation_run_r2_batches")
      .values({
        run_id: input.runId,
        batch_index: batchIndex,
        keys_json: JSON.stringify(validKeys),
        processed: 0,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.columns(["run_id", "batch_index"]).doUpdateSet({
          keys_json: JSON.stringify(validKeys),
          updated_at: now,
        })
      )
      .execute();
  }

  let nextCursor: string | undefined = undefined;
  let nextPrefixIdx = r2ListConfig.currentPrefixIdx;
  let nextPrefixPagesProcessed = (r2ListConfig.prefixPagesProcessed || 0) + 1;

  const maxPagesPerPrefix =
    prefixes.length > 1 ? Math.ceil(maxPages / prefixes.length) : maxPages;

  if (nextPrefixPagesProcessed >= maxPagesPerPrefix || !result.truncated) {
    nextPrefixIdx++;
    nextCursor = undefined;
    nextPrefixPagesProcessed = 0;
  } else {
    nextCursor = result.cursor;
  }

  const nextConfig = {
    ...config,
    r2List: {
      ...r2ListConfig,
      currentPrefixIdx: nextPrefixIdx,
      cursor: nextCursor,
      pagesProcessed: r2ListConfig.pagesProcessed + 1,
      prefixPagesProcessed: nextPrefixPagesProcessed,
    },
  };

  await db
    .updateTable("simulation_runs")
    .set({
      config_json: JSON.stringify(nextConfig),
      updated_at: now,
      last_progress_at: now,
    } as any)
    .where("run_id", "=", input.runId)
    .execute();

  if (nextPrefixIdx < prefixes.length || result.truncated) {
    return { status: "running", currentPhase: "r2_listing" };
  } else {
    return { status: "advance", currentPhase: "r2_listing" };
  }
}

async function recoverPhaseZombies(
  context: SimulationDbContext,
  input: { runId: string; phase: string }
): Promise<void> {
  const db = getSimulationDb(context);
  const phase = input.phase;
  const zombieThreshold = new Date(Date.now() - 30000).toISOString(); // 30s timeout

  const zombies = (await db
    .selectFrom("simulation_run_documents")
    .select(["r2_key", "attempts_json"])
    .where("run_id", "=", input.runId)
    .where(sql`json_extract(COALESCE(dispatched_phases_json, '[]'), '$')`, "like", `%${phase}%`)
    .where(sql`json_extract(COALESCE(processed_phases_json, '[]'), '$')`, "not like", `%${phase}%`)
    .where("updated_at", "<", zombieThreshold)
    .execute()) as unknown as SimulationRunDocumentRow[];

  if (zombies.length > 0) {
    const MAX_ATTEMPTS = 3;
    console.log(`[runner] Recovering ${zombies.length} zombies for ${phase}`);
    for (const z of zombies) {
      const attempts = (z.attempts_json || {}) as Record<string, number>;
      const currentAttempts = (attempts[phase] || 1) + 1; // Start at 1 because we already sent it once
      attempts[phase] = currentAttempts;

      if (currentAttempts > MAX_ATTEMPTS) {
        console.warn(`[runner] Ditching document ${z.r2_key} for phase ${phase} after ${currentAttempts} attempts`);
        await db.updateTable("simulation_run_documents")
          .set({
            processed_phases_json: sql`json_insert(COALESCE(processed_phases_json, '[]'), '$[#]', ${phase})`,
            updated_at: new Date().toISOString()
          } as any)
          .where("run_id", "=", input.runId)
          .where("r2_key", "=", z.r2_key)
          .execute();
        
        await addSimulationRunEvent(context, {
          runId: input.runId,
          level: "warn",
          kind: "phase.document_ditched",
          payload: { phase, r2Key: z.r2_key, attempts: currentAttempts }
        });
      } else {
        await db.updateTable("simulation_run_documents")
          .set({
            attempts_json: JSON.stringify(attempts),
            updated_at: new Date().toISOString()
          } as any)
          .where("run_id", "=", input.runId)
          .where("r2_key", "=", z.r2_key)
          .execute();

        await (context.env as any).ENGINE_INDEXING_QUEUE.send({
          jobType: "simulation-document",
          runId: input.runId,
          phase,
          r2Key: z.r2_key,
        });
      }
    }
  }
}

async function tickGenericDocumentPolling(
  context: SimulationDbContext,
  input: { runId: string; phase: string }
): Promise<{ status: string; currentPhase: string } | null> {
  const db = getSimulationDb(context);
  const phase = input.phase;
  const now = new Date().toISOString();

  if (phase === "ingest_diff") {
    // Special case: ingest_diff polls r2_batches
    const batch = await db
      .selectFrom("simulation_run_r2_batches")
      .select(["batch_index", "keys_json"])
      .where("run_id", "=", input.runId)
      .where("processed", "=", 0)
      .executeTakeFirst();

    if (batch) {
      const row = batch as unknown as SimulationRunR2BatchRow;
      const keys = row.keys_json;
      for (const r2Key of keys) {
        await db
          .insertInto("simulation_run_documents")
          .values({
            run_id: input.runId,
            r2_key: r2Key,
            dispatched_phases_json: JSON.stringify([phase]),
            processed_phases_json: JSON.stringify([]),
            changed: 0,
            processed_at: now,
            updated_at: now,
          })
          .onConflict((oc) =>
            oc.columns(["run_id", "r2_key"]).doUpdateSet({
              dispatched_phases_json: sql`json_insert(COALESCE(dispatched_phases_json, '[]'), '$[#]', ${phase})`,
              updated_at: now,
            })
          )
          .execute();

        await (context.env as any).ENGINE_INDEXING_QUEUE.send({
          jobType: "simulation-document",
          runId: input.runId,
          phase,
          r2Key,
        });
      }

      await db
        .updateTable("simulation_run_r2_batches")
        .set({ processed: 1, updated_at: now })
        .where("run_id", "=", input.runId)
        .where("batch_index", "=", batch.batch_index)
        .execute();

      return { status: "running", currentPhase: phase };
    }
  } else if (phase === "micro_batches") {
      // Special case: micro_batches polls simulation_run_documents that have completed ingest_diff
      const docs = await db
        .selectFrom("simulation_run_documents")
        .select(["r2_key"])
        .where("run_id", "=", input.runId)
        .where(sql`json_extract(COALESCE(processed_phases_json, '[]'), '$')`, "like", `%ingest_diff%`)
        .where(sql`json_extract(COALESCE(dispatched_phases_json, '[]'), '$')`, "not like", `%${phase}%`)
        .limit(10)
        .execute();
      
      if (docs.length > 0) {
          for (const doc of docs) {
              await db.updateTable("simulation_run_documents")
                .set({
                    dispatched_phases_json: sql`json_insert(COALESCE(dispatched_phases_json, '[]'), '$[#]', ${phase})`,
                    updated_at: now
                } as any)
                .where("run_id", "=", input.runId)
                .where("r2_key", "=", doc.r2_key)
                .execute();
              
              await (context.env as any).ENGINE_INDEXING_QUEUE.send({
                  jobType: "simulation-document",
                  runId: input.runId,
                  phase,
                  r2Key: doc.r2_key
              });
          }
          return { status: "running", currentPhase: phase };
      }
  } else {
    // Generic case: Poll simulation_run_documents that have completed the PREVIOUS phase
    const allPhases = [
      "ingest_diff",
      "micro_batches",
      "macro_synthesis",
      "macro_classification",
      "materialize_moments",
      "deterministic_linking",
      "candidate_sets",
      "timeline_fit",
    ];
    const currentIdx = allPhases.indexOf(phase);
    const prevPhase = allPhases[currentIdx - 1];

    if (prevPhase) {
      const docs = await db
        .selectFrom("simulation_run_documents")
        .select(["r2_key"])
        .where("run_id", "=", input.runId)
        .where(sql`json_extract(COALESCE(processed_phases_json, '[]'), '$')`, "like", `%${prevPhase}%`)
        .where(sql`json_extract(COALESCE(dispatched_phases_json, '[]'), '$')`, "not like", `%${phase}%`)
        .limit(50)
        .execute();

      if (docs.length > 0) {
        for (const doc of docs) {
          await db
            .updateTable("simulation_run_documents")
            .set({
              dispatched_phases_json: sql`json_insert(COALESCE(dispatched_phases_json, '[]'), '$[#]', ${phase})`,
              updated_at: now,
            } as any)
            .where("run_id", "=", input.runId)
            .where("r2_key", "=", doc.r2_key)
            .execute();

          await (context.env as any).ENGINE_INDEXING_QUEUE.send({
            jobType: "simulation-document",
            runId: input.runId,
            phase,
            r2Key: doc.r2_key,
          });
        }
        return { status: "running", currentPhase: phase };
      }
    }
  }

  // If no work dispatched, check if all documents are processed for this phase
  const pending = await db
    .selectFrom("simulation_run_documents")
    .select([sql<number>`count(*)`.as("count")])
    .where("run_id", "=", input.runId)
    .where(sql`json_extract(COALESCE(dispatched_phases_json, '[]'), '$')`, "like", `%${phase}%`)
    .where(sql`json_extract(COALESCE(processed_phases_json, '[]'), '$')`, "not like", `%${phase}%`)
    .executeTakeFirst();

  if (toNumber(pending?.count) > 0) {
    const total = (await db
      .selectFrom("simulation_run_documents")
      .select([sql<number>`count(*)`.as("count")])
      .where("run_id", "=", input.runId)
      .executeTakeFirst()) as any;

    const processed = (await db
      .selectFrom("simulation_run_documents")
      .select([sql<number>`count(*)`.as("count")])
      .where("run_id", "=", input.runId)
      .where(
        sql`json_extract(COALESCE(processed_phases_json, '[]'), '$')`,
        "like",
        `%${phase}%`
      )
      .executeTakeFirst()) as any;

    const totalCount = toNumber(total?.count);
    const processedCount = toNumber(processed?.count);
    const pendingCount = toNumber(pending?.count);

    await addSimulationRunEvent(context, {
      runId: input.runId,
      level: "info",
      kind: "phase.progress",
      payload: {
        phase,
        processed: processedCount,
        total: totalCount,
        pending: pendingCount,
      },
    });

    console.log(
      `[runner] Run ${input.runId} phase ${phase} in progress: ${processedCount}/${totalCount} docs processed (${pendingCount} pending)`
    );

    return {
      status: "awaiting_documents",
      currentPhase: phase,
    };
  }

  // Check r2_batches for ingest_diff
  if (phase === "ingest_diff") {
    const batchPending = await db
      .selectFrom("simulation_run_r2_batches")
      .select([sql<number>`count(*)`.as("count")])
      .where("run_id", "=", input.runId)
      .where("processed", "=", 0)
      .executeTakeFirst();
    if (toNumber(batchPending?.count) > 0) {
      return { status: "running", currentPhase: phase };
    }
  }

  // Completion check
  const anyPendingInRun = await db
    .selectFrom("simulation_run_documents")
    .select([sql<number>`count(*)`.as("count")])
    .where("run_id", "=", input.runId)
    .where(sql`json_extract(COALESCE(processed_phases_json, '[]'), '$')`, "not like", `%${phase}%`)
    .executeTakeFirst();

  if (toNumber(anyPendingInRun?.count) > 0) {
    return { status: "awaiting_documents", currentPhase: phase };
  }

  return { status: "advance", currentPhase: phase };
}

function toNumber(value: any): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return parseInt(value, 10);
  return 0;
}

