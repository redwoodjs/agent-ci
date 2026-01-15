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
      const parsedDocumentIdentity = buildParsedDocumentIdentity(document);
      const normalizedStreams = streams.map((s) => {
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
              const microPathsJson = Array.isArray(moment.microPaths)
                ? JSON.stringify(moment.microPaths)
                : null;
              const sourceMetadataJson =
                typeof moment.sourceMetadata === "object" && moment.sourceMetadata
                  ? JSON.stringify(moment.sourceMetadata)
                  : null;

              await input.momentDb
                .insertInto("moments")
                .values({
                  id: moment.id,
                  document_id: moment.documentId,
                  summary: moment.summary,
                  title: moment.title,
                  parent_id: null as any,
                  micro_paths_json: (microPathsJson ?? null) as any,
                  micro_paths_hash: ((moment.microPathsHash ?? null) as any) as any,
                  importance:
                    typeof moment.importance === "number" &&
                    Number.isFinite(moment.importance)
                      ? (moment.importance as any)
                      : (null as any),
                  link_audit_log: null as any,
                  is_subject: (moment.isSubject === true ? 1 : 0) as any,
                  subject_kind:
                    typeof moment.subjectKind === "string"
                      ? (moment.subjectKind as any)
                      : (null as any),
                  subject_reason:
                    typeof moment.subjectReason === "string"
                      ? (moment.subjectReason as any)
                      : (null as any),
                  subject_evidence_json: Array.isArray(moment.subjectEvidence)
                    ? (JSON.stringify(moment.subjectEvidence) as any)
                    : (null as any),
                  moment_kind:
                    typeof moment.momentKind === "string"
                      ? (moment.momentKind as any)
                      : (null as any),
                  moment_evidence_json: Array.isArray(moment.momentEvidence)
                    ? (JSON.stringify(moment.momentEvidence) as any)
                    : (null as any),
                  created_at: moment.createdAt,
                  author: moment.author,
                  source_metadata: (sourceMetadataJson ?? null) as any,
                } as any)
                .onConflict((oc: any) =>
                  oc.column("id").doUpdateSet({
                    summary: moment.summary,
                    title: moment.title,
                    parent_id: null as any,
                    micro_paths_json: (microPathsJson ?? null) as any,
                    micro_paths_hash: ((moment.microPathsHash ?? null) as any) as any,
                    importance:
                      typeof moment.importance === "number" &&
                      Number.isFinite(moment.importance)
                        ? (moment.importance as any)
                        : (null as any),
                    is_subject: (moment.isSubject === true ? 1 : 0) as any,
                    subject_kind:
                      typeof moment.subjectKind === "string"
                        ? (moment.subjectKind as any)
                        : (null as any),
                    subject_reason:
                      typeof moment.subjectReason === "string"
                        ? (moment.subjectReason as any)
                        : (null as any),
                    subject_evidence_json: Array.isArray(moment.subjectEvidence)
                      ? (JSON.stringify(moment.subjectEvidence) as any)
                      : (null as any),
                    moment_kind:
                      typeof moment.momentKind === "string"
                        ? (moment.momentKind as any)
                        : (null as any),
                    moment_evidence_json: Array.isArray(moment.momentEvidence)
                      ? (JSON.stringify(moment.momentEvidence) as any)
                      : (null as any),
                    created_at: moment.createdAt,
                    author: moment.author,
                    source_metadata: (sourceMetadataJson ?? null) as any,
                  } as any)
                )
                .execute();
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
          effectiveNamespace: input.effectiveNamespace ?? null,
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

