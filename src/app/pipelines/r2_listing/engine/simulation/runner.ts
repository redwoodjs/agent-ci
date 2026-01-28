import { registerPipeline, type PipelineRegistryEntry } from "../../../../engine/simulation/registry";
import { getSimulationDb } from "../../../../engine/simulation/db";
import { addSimulationRunEvent } from "../../../../engine/simulation/runEvents";

export const r2_listing_simulation: PipelineRegistryEntry = {
  phase: "r2_listing" as const,
  label: "R2 Listing",

  async onTick(context, input) {
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

      return { status: "running", currentPhase: "ingest_diff" };
    }

    if (!r2ListConfig) {
      return { status: "running", currentPhase: "ingest_diff" };
    }

    const bucket = (context.env as any).MACHINEN_BUCKET as R2Bucket;
    if (!bucket) throw new Error("MACHINEN_BUCKET not found in env");

    if (typeof r2ListConfig.currentPrefixIdx !== "number") {
      r2ListConfig.currentPrefixIdx = 0;
      r2ListConfig.pagesProcessed = 0;
      r2ListConfig.prefixPagesProcessed = 0;
    }

    const prefixes = Array.isArray(r2ListConfig.targetPrefixes) ? r2ListConfig.targetPrefixes : [];
    const limit = r2ListConfig.limitPerPage || 1000;
    const maxPages = r2ListConfig.maxPages || 1000;

    if (r2ListConfig.currentPrefixIdx >= prefixes.length || r2ListConfig.pagesProcessed >= maxPages) {
      return { status: "running", currentPhase: "ingest_diff" };
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
    const keys = result.objects.map(o => o.key).filter(k => !!k);
    
    // Filtering logic
    const isGithubIssue = (k: string) => k.startsWith("github/") && k.includes("/issues/") && k.endsWith("/latest.json");
    const isGithubPr = (k: string) => k.startsWith("github/") && k.includes("/pull-requests/") && k.endsWith("/latest.json");
    const isDiscord = (k: string) => k.startsWith("discord/");
    const isCursor = (k: string) => k.startsWith("cursor/conversations/");
    const filterSupported = (k: string) => isGithubIssue(k) || isGithubPr(k) || isDiscord(k) || isCursor(k);

    const validKeys = keys.filter(filterSupported);

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
          .onConflict(oc => oc.columns(["run_id", "batch_index"]).doUpdateSet({
              keys_json: JSON.stringify(validKeys),
              updated_at: now
          }))
          .execute();
    }

    let nextCursor: string | undefined = undefined;
    let nextPrefixIdx = r2ListConfig.currentPrefixIdx;
    let nextPrefixPagesProcessed = (r2ListConfig.prefixPagesProcessed || 0) + 1;

    const maxPagesPerPrefix = prefixes.length > 1
      ? Math.ceil(maxPages / prefixes.length)
      : maxPages;

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
      }
    };

    await db.updateTable("simulation_runs")
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
       return { status: "running", currentPhase: "ingest_diff" };
    }
  },

  async onExecute() {
    // No-op for listing
  },

  async recoverZombies() {
    // No-op for listing
  }
};

registerPipeline(r2_listing_simulation);
