import type {
  SimulationDbContext,
  SimulationRunMacroClassifiedOutputRow,
} from "../../../../engine/simulation/types";
import { getSimulationDb } from "../../../../engine/simulation/db";
import { getIndexingPlugins } from "../../../../engine/indexing/indexingPlugins";
import { prepareDocumentForR2Key } from "../../../../engine/indexing/pluginPipeline";
import { sha256Hex, uuidFromSha256Hex } from "../../../../engine/utils/crypto";
import {
  computeMaterializedMomentIdentity,
  computeMicroPathsHash,
} from "../../../../engine/lib/phaseCores/materializeMomentsCore";
import { materializeMomentsForDocument } from "../core/orchestrator";
import {
  buildParsedDocumentIdentity,
  mergeMomentSourceMetadata,
} from "../../../../engine/utils/provenance";
import {
  computeMomentGraphNamespaceForIndexing,
  getMicroPromptContext,
} from "../../../../engine/indexing/pluginPipeline";
import {
  applyMomentGraphNamespacePrefixValue,
  getMomentGraphNamespacePrefixFromEnv,
} from "../../../../engine/momentGraphNamespace";
import { getMomentGraphDb } from "../../../../engine/simulation/db";
import { addMoment } from "../../../../engine/databases/momentGraph";

export async function runMaterializeMomentsAdapter(
  context: SimulationDbContext,
  input: {
    runId: string;
    r2Keys: string[];
    effectiveNamespace: string | null;
    momentDb: any;
    now: string;
    log: {
      error: (kind: string, payload: any) => Promise<void>;
      warn: (kind: string, payload: any) => Promise<void>;
      info: (kind: string, payload: any) => Promise<void>;
      debug: (kind: string, payload: any) => Promise<void>;
    };
  }
): Promise<{
  docsProcessed: number;
  docsSkippedUnchanged: number;
  momentsUpserted: number;
  failed: number;
  failures: Array<{ r2Key: string; error: string }>;
}> {
  const db = getSimulationDb(context);
  const plugins = getIndexingPlugins(context.env);

  let momentsUpserted = 0;
  let docsSkippedUnchanged = 0;
  let docsProcessed = 0;
  let failed = 0;
  const failures: Array<{ r2Key: string; error: string }> = [];
  const participatingNamespaces = new Set<string>();

  for (const r2Key of input.r2Keys) {
    const docState = (await db
      .selectFrom("simulation_run_documents")
      .select(["changed", "error_json"])
      .where("run_id", "=", input.runId)
      .where("r2_key", "=", r2Key)
      .executeTakeFirst()) as unknown as
      | { changed: number; error_json: any }
      | undefined;

    const hadError = Boolean((docState as any)?.error_json);
    const changedFlag = Number((docState as any)?.changed ?? 1) !== 0;


    if (hadError) {
      failed++;
      failures.push({ r2Key, error: "ingest_diff error" });
      continue;
    }

    if (!changedFlag) {
      docsSkippedUnchanged++;
      continue;
    }

    // Get namespace configurations
    const runRow = (await db
      .selectFrom("simulation_runs")
      .select(["moment_graph_namespace_prefix"])
      .where("run_id", "=", input.runId)
      .executeTakeFirst()) as any;
    const prefix = runRow?.moment_graph_namespace_prefix ?? null;

    const macroRow = (await db
      .selectFrom("simulation_run_macro_classified_outputs")
      .select(["streams_json"])
      .where("run_id", "=", input.runId)
      .where("r2_key", "=", r2Key)
      .executeTakeFirst()) as unknown as
      | SimulationRunMacroClassifiedOutputRow
      | undefined;

    if (!macroRow) {
      failed++;
      failures.push({ r2Key, error: "missing macro_classification outputs" });
      continue;
    }

    docsProcessed++;

    await input.log.info("item.start", {
      phase: "materialize_moments",
      r2Key,
    });

    const streamsAny = (macroRow as any).streams_json;
    const streams = Array.isArray(streamsAny)
      ? (streamsAny as any[])
      : typeof streamsAny === "string"
      ? (() => {
          try {
            return JSON.parse(streamsAny);
          } catch {
            return [];
          }
        })()
      : [];

    try {
      const { document, indexingContext } = await prepareDocumentForR2Key(
        r2Key,
        context.env,
        plugins
      );

      const baseDocNamespace = await computeMomentGraphNamespaceForIndexing(
        document,
        indexingContext,
        plugins
      );

      const effectiveNamespace = applyMomentGraphNamespacePrefixValue(
        baseDocNamespace,
        prefix
      );

      await input.log.info("debug.resolved_namespace", {
        phase: "materialize_moments",
        r2Key,
        effectiveNamespace,
      });

      if (effectiveNamespace) {
        participatingNamespaces.add(effectiveNamespace);
      }

      const momentDb = getMomentGraphDb(context.env, effectiveNamespace);
      const parsedDocumentIdentity = buildParsedDocumentIdentity(document);
      const normalizedStreams = streams.map((s: any) => {
        const macroMoments = Array.isArray((s as any)?.macroMoments)
          ? ((s as any).macroMoments as any[])
          : [];
        const normalizedMacroMoments = macroMoments.map((m) => {
          const createdAt =
            typeof m?.createdAt === "string" && m.createdAt.trim().length > 0
              ? m.createdAt.trim()
              : document.metadata?.createdAt ?? input.now;
          const author =
            typeof m?.author === "string" && m.author.trim().length > 0
              ? m.author.trim()
              : document.metadata?.author ?? "unknown";
          const mergedSourceMetadata = mergeMomentSourceMetadata({
            existing: m?.sourceMetadata,
            parsedDocumentIdentity,
            timeRange: (m?.sourceMetadata as any)?.timeRange ?? null,
          });
          return {
            ...m,
            createdAt,
            author,
            sourceMetadata: mergedSourceMetadata,
          };
        });
        return { ...s, macroMoments: normalizedMacroMoments };
      });

      for (const stream of normalizedStreams) {
        const did = await materializeMomentsForDocument({
          ports: {
            computeMomentId: async ({
              effectiveNamespace,
              documentId,
              streamId,
              macroIndex,
            }) => {
              const { momentId } = await computeMaterializedMomentIdentity({
                runId: input.runId,
                effectiveNamespace,
                documentId,
                streamId,
                macroIndex,
                sha256Hex,
                uuidFromSha256Hex,
              });
              return momentId;
            },
            computeMicroPathsHash: async ({ microPaths }) => {
              return await computeMicroPathsHash({ microPaths, sha256Hex });
            },
            upsertMoment: async ({ moment }) => {
              await addMoment(moment as any, {
                env: context.env,
                momentGraphNamespace: effectiveNamespace ?? null,
                log: input.log,
              });
            },
            persistMaterializedMoment: async ({
              r2Key,
              streamId,
              macroIndex,
              momentId,
            }) => {
              await db
                .insertInto("simulation_run_materialized_moments")
                .values({
                  run_id: input.runId,
                  r2_key: r2Key,
                  stream_id: streamId,
                  macro_index: macroIndex as any,
                  moment_id: momentId,
                  created_at: input.now,
                  updated_at: input.now,
                } as any)
                .onConflict((oc) =>
                  oc
                    .columns(["run_id", "r2_key", "stream_id", "macro_index"])
                    .doUpdateSet({
                      moment_id: momentId,
                      updated_at: input.now,
                    } as any)
                )
                .execute();
            },
          },
          effectiveNamespace: effectiveNamespace ?? null,
          runIdOrScope: input.runId,
          r2Key,
          documentId: document.id,
          now: input.now,
          streams: [
            {
              streamId:
                typeof (stream as any)?.streamId === "string"
                  ? (stream as any).streamId
                  : "stream",
              macroMoments: Array.isArray((stream as any)?.macroMoments)
                ? ((stream as any).macroMoments as any[])
                : [],
            },
          ],
        });

        momentsUpserted += did.momentsUpserted;
      }

      await input.log.info("item.success", {
        phase: "materialize_moments",
        r2Key,
        momentsUpserted: streams.reduce(
          (acc: number, s: any) => acc + (Array.isArray((s as any)?.macroMoments) ? (s as any).macroMoments.length : 0),
          0
        ),
      });
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({ r2Key, error: msg });
      await input.log.error("item.error", {
        phase: "materialize_moments",
        r2Key,
        error: msg,
      });
    }
  }

  // Record participating namespaces
  if (participatingNamespaces.size > 0) {
    const namespaces = Array.from(participatingNamespaces);
    // Batch insert namespaces
    // Since Kysely doesn't support ON CONFLICT DO NOTHING for arbitrary primary keys universally clearly in all dialects without specific syntax,
    // and we want to be safe, we'll just do individual inserts or a careful batch with ignore.
    // SQLite supports INSERT OR IGNORE.
    
    // We can just loop and insert ignore. It's low volume (1-2 namespaces per batch usually).
    for (const ns of namespaces) {
      await db
        .insertInto("simulation_run_participating_namespaces")
        .values({
          run_id: input.runId,
          namespace: ns,
          created_at: input.now,
        } as any)
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
  }

  return {
    docsProcessed,
    docsSkippedUnchanged,
    momentsUpserted,
    failed,
    failures,
  };
}

