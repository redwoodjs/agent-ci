import type { SimulationDbContext, SimulationRunMacroOutputRow } from "../types";
import { getSimulationDb } from "../db";
import { getIndexingPlugins } from "../../../indexing/indexingPlugins";
import { prepareDocumentForR2Key } from "../../../indexing/pluginPipeline";
import { sha256Hex, uuidFromSha256Hex } from "../../../utils/crypto";
import { computeMaterializedMomentIdentity, computeMicroPathsHash } from "../../../lib/phaseCores/materialize_moments_core";

export async function runMaterializeMomentsAdapter(
  context: SimulationDbContext,
  input: {
    runId: string;
    r2Keys: string[];
    effectiveNamespace: string | null;
    momentDb: any;
    now: string;
    log: { error: (kind: string, payload: any) => Promise<void> };
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

    const macroRow = (await db
      .selectFrom("simulation_run_macro_outputs")
      .select(["streams_json"])
      .where("run_id", "=", input.runId)
      .where("r2_key", "=", r2Key)
      .executeTakeFirst()) as unknown as SimulationRunMacroOutputRow | undefined;

    if (!macroRow) {
      continue;
    }

    docsProcessed++;

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
      const { document } = await prepareDocumentForR2Key(
        r2Key,
        context.env,
        plugins
      );

      for (const stream of streams) {
        const streamId =
          typeof (stream as any)?.streamId === "string"
            ? (stream as any).streamId
            : "stream";
        const macroMoments = Array.isArray((stream as any)?.macroMoments)
          ? ((stream as any).macroMoments as any[])
          : [];

        for (let i = 0; i < macroMoments.length; i++) {
          const m = macroMoments[i] ?? {};
          const title =
            typeof m.title === "string" && m.title.trim().length > 0
              ? m.title.trim()
              : "(untitled)";
          const summary =
            typeof m.summary === "string" && m.summary.trim().length > 0
              ? m.summary.trim()
              : "(empty)";
          const createdAt =
            typeof m.createdAt === "string" && m.createdAt.trim().length > 0
              ? m.createdAt.trim()
              : input.now;
          const author =
            typeof m.author === "string" && m.author.trim().length > 0
              ? m.author.trim()
              : "machinen";
          const microPaths = Array.isArray(m.microPaths)
            ? m.microPaths.filter((p: any) => typeof p === "string")
            : null;

          const microPathsHash = await computeMicroPathsHash({
            microPaths,
            sha256Hex,
          });

          const { momentId } = await computeMaterializedMomentIdentity({
            runId: input.runId,
            effectiveNamespace: input.effectiveNamespace ?? null,
            documentId: document.id,
            streamId,
            macroIndex: i,
            sha256Hex,
            uuidFromSha256Hex,
          });

          await input.momentDb
            .insertInto("moments")
            .values({
              id: momentId,
              document_id: document.id,
              summary,
              title,
              parent_id: null as any,
              micro_paths_json: microPaths
                ? JSON.stringify(microPaths)
                : (null as any),
              micro_paths_hash: (microPathsHash ?? null) as any,
              importance:
                typeof m.importance === "number" && Number.isFinite(m.importance)
                  ? (m.importance as any)
                  : (null as any),
              link_audit_log: null as any,
              is_subject: (m.isSubject === true ? 1 : 0) as any,
              subject_kind:
                typeof m.subjectKind === "string"
                  ? (m.subjectKind as any)
                  : (null as any),
              subject_reason:
                typeof m.subjectReason === "string"
                  ? (m.subjectReason as any)
                  : (null as any),
              subject_evidence_json: Array.isArray(m.subjectEvidence)
                ? (JSON.stringify(m.subjectEvidence) as any)
                : (null as any),
              moment_kind:
                typeof m.momentKind === "string"
                  ? (m.momentKind as any)
                  : (null as any),
              moment_evidence_json: Array.isArray(m.momentEvidence)
                ? (JSON.stringify(m.momentEvidence) as any)
                : (null as any),
              created_at: createdAt,
              author,
              source_metadata:
                typeof m.sourceMetadata === "object" && m.sourceMetadata
                  ? (JSON.stringify(m.sourceMetadata) as any)
                  : (JSON.stringify({
                      simulation: {
                        runId: input.runId,
                        r2Key,
                        streamId,
                        macroIndex: i,
                      },
                    }) as any),
            } as any)
            .onConflict((oc) =>
              oc.column("id").doUpdateSet({
                summary,
                title,
                parent_id: null as any,
                micro_paths_json: microPaths
                  ? JSON.stringify(microPaths)
                  : (null as any),
                micro_paths_hash: (microPathsHash ?? null) as any,
                importance:
                  typeof m.importance === "number" && Number.isFinite(m.importance)
                    ? (m.importance as any)
                    : (null as any),
                is_subject: (m.isSubject === true ? 1 : 0) as any,
                subject_kind:
                  typeof m.subjectKind === "string"
                    ? (m.subjectKind as any)
                    : (null as any),
                subject_reason:
                  typeof m.subjectReason === "string"
                    ? (m.subjectReason as any)
                    : (null as any),
                subject_evidence_json: Array.isArray(m.subjectEvidence)
                  ? (JSON.stringify(m.subjectEvidence) as any)
                  : (null as any),
                moment_kind:
                  typeof m.momentKind === "string"
                    ? (m.momentKind as any)
                    : (null as any),
                moment_evidence_json: Array.isArray(m.momentEvidence)
                  ? (JSON.stringify(m.momentEvidence) as any)
                  : (null as any),
                created_at: createdAt,
                author,
              } as any)
            )
            .execute();

          await db
            .insertInto("simulation_run_materialized_moments")
            .values({
              run_id: input.runId,
              r2_key: r2Key,
              stream_id: streamId,
              macro_index: i as any,
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

          momentsUpserted++;
        }
      }
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

  return {
    docsProcessed,
    docsSkippedUnchanged,
    momentsUpserted,
    failed,
    failures,
  };
}

