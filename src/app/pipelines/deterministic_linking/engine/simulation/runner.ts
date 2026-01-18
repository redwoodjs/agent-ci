import { applyMomentGraphNamespacePrefixValue } from "../../../../engine/momentGraphNamespace";
import type { SimulationDbContext } from "../../../../engine/simulation/types";
import {
  getMomentGraphDb,
  getSimulationDb,
} from "../../../../engine/simulation/db";
import { addSimulationRunEvent } from "../../../../engine/simulation/runEvents";
import { createSimulationRunLogger } from "../../../../engine/simulation/logger";
import { simulationPhases } from "../../../../engine/simulation/types";
import { addMoment, getMoments } from "../../../../engine/databases/momentGraph";
import { resolveThreadHeadForDocumentAsOf } from "../../../../engine/core/linking/explicitRefThreadHead";
import { computeDeterministicLinkingDecision } from "../../../../engine/core/linking/deterministicLinkingOrchestrator";

function parseIssueRefs(tokens: unknown): string[] {
  if (!Array.isArray(tokens)) {
    return [];
  }
  const out: string[] = [];
  for (const t of tokens) {
    if (typeof t !== "string") {
      continue;
    }
    const m = t.match(/^#(\d{1,10})$/);
    if (!m) {
      continue;
    }
    out.push(m[1]);
  }
  return out;
}

function issueNumberFromR2Key(r2Key: string): string | null {
  const m = r2Key.match(/\/(issues|pull-requests)\/(\d{1,10})\//);
  if (!m) {
    return null;
  }
  return m[2] ?? null;
}

function parseGithubRepoFromKey(
  r2Key: string
): { owner: string; repo: string } | null {
  const m = r2Key.match(/^github\/([^/]+)\/([^/]+)\//);
  if (!m) {
    return null;
  }
  const owner = m[1] ?? "";
  const repo = m[2] ?? "";
  if (!owner || !repo) {
    return null;
  }
  return { owner, repo };
}

function parseTimeMs(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

function computeMomentStartMs(input: {
  createdAt: string;
  sourceMetadata?: Record<string, any>;
}): number | null {
  const range = (input.sourceMetadata as any)?.timeRange;
  const start = typeof range?.start === "string" ? range.start : null;
  const rangeStart = start ? parseTimeMs(start) : null;
  if (rangeStart !== null) {
    return rangeStart;
  }
  return parseTimeMs(input.createdAt);
}

export async function runPhaseDeterministicLinking(
  context: SimulationDbContext,
  input: { runId: string; phaseIdx: number }
): Promise<{ status: string; currentPhase: string } | null> {
  const db = getSimulationDb(context);
  const now = new Date().toISOString();
  const log = createSimulationRunLogger(context, { runId: input.runId });
  const verbosityRaw = String(
    (context.env as any).MACHINEN_SIMULATION_EVENT_VERBOSITY ?? ""
  )
    .trim()
    .toLowerCase();
  const verbose =
    verbosityRaw === "1" ||
    verbosityRaw === "true" ||
    verbosityRaw === "verbose" ||
    verbosityRaw === "item";

  const runRow = (await db
    .selectFrom("simulation_runs")
    .select([
      "config_json",
      "moment_graph_namespace",
      "moment_graph_namespace_prefix",
    ])
    .where("run_id", "=", input.runId)
    .executeTakeFirst()) as unknown as
    | {
        config_json: any;
        moment_graph_namespace: string | null;
        moment_graph_namespace_prefix: string | null;
      }
    | undefined;

  if (!runRow) {
    return null;
  }

  const baseNamespace =
    typeof (runRow as any).moment_graph_namespace === "string"
      ? ((runRow as any).moment_graph_namespace as string)
      : null;
  const prefix =
    typeof (runRow as any).moment_graph_namespace_prefix === "string"
      ? ((runRow as any).moment_graph_namespace_prefix as string)
      : null;
  const effectiveNamespace =
    baseNamespace && prefix
      ? applyMomentGraphNamespacePrefixValue(baseNamespace, prefix)
      : baseNamespace;

  const config = (runRow as any).config_json ?? {};
  const r2KeysRaw = (config as any)?.r2Keys;
  const r2Keys =
    Array.isArray(r2KeysRaw) && r2KeysRaw.every((k) => typeof k === "string")
      ? (r2KeysRaw as string[])
      : [];

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: "info",
    kind: "phase.start",
    payload: {
      phase: "deterministic_linking",
      r2KeysCount: r2Keys.length,
      effectiveNamespace: effectiveNamespace ?? null,
    },
  });

  const mappings = (await db
    .selectFrom("simulation_run_materialized_moments")
    .selectAll()
    .where("run_id", "=", input.runId)
    .execute()) as unknown as Array<{
    r2_key: string;
    stream_id: string;
    macro_index: number;
    moment_id: string;
  }>;

  const byStream = new Map<string, Array<(typeof mappings)[number]>>();
  for (const row of mappings) {
    const key = `${row.r2_key}\n${row.stream_id}`;
    const list = byStream.get(key) ?? [];
    list.push(row);
    byStream.set(key, list);
  }
  for (const list of byStream.values()) {
    list.sort((a, b) => (a.macro_index ?? 0) - (b.macro_index ?? 0));
  }

  let momentsProcessed = 0;
  let attached = 0;
  let rejected = 0;
  let leftUnlinked = 0;
  let failed = 0;

  const momentGraphContext = {
    env: context.env,
    momentGraphNamespace: effectiveNamespace ?? null,
  };

  const momentIds = mappings.map((m) => m.moment_id).filter(Boolean);
  const momentsMap = await getMoments(momentIds, momentGraphContext);

  for (const [key, list] of byStream.entries()) {
    const [r2Key, streamId] = key.split("\n");
    if (!r2Key || !streamId) {
      continue;
    }

    const macroRow = (await db
      .selectFrom("simulation_run_macro_outputs")
      .select(["anchors_json"])
      .where("run_id", "=", input.runId)
      .where("r2_key", "=", r2Key)
      .executeTakeFirst()) as any;

    const issueRefs = parseIssueRefs(macroRow?.anchors_json);
    const candidateIssueNumber = issueRefs[0] ?? null;
    const repo = candidateIssueNumber ? parseGithubRepoFromKey(r2Key) : null;

    for (let i = 0; i < list.length; i++) {
      const row = list[i]!;
      const macroIndex = Number(row.macro_index ?? 0);
      const childMomentId = row.moment_id;
      const prev = i > 0 ? list[i - 1]?.moment_id ?? null : null;

      momentsProcessed++;

      await log.info("item.start", {
        phase: "deterministic_linking",
        r2Key,
        childMomentId,
      });

      let matchedAnchorMomentId: string | null = null;
      const child = momentsMap.get(childMomentId) ?? null;
      const childText = child
        ? `${child.title ?? ""}\n${child.summary ?? ""}`.trim()
        : "";

      const deterministic = await computeDeterministicLinkingDecision({
        ports: {
          resolveThreadHeadForDocumentAsOf: async ({ documentId, asOfMs }) => {
            const resolved = await resolveThreadHeadForDocumentAsOf({
              documentId,
              asOfMs,
              context: momentGraphContext,
            });
            matchedAnchorMomentId = resolved.anchorMomentId;
            return resolved;
          },
        },
        r2Key,
        streamId,
        macroIndex,
        childMomentId,
        prevMomentId: prev,
        childDocumentId: r2Key,
        childCreatedAt: child?.createdAt ?? now,
        childSourceMetadata: child?.sourceMetadata,
        macroAnchors: Array.isArray(macroRow?.anchors_json)
          ? (macroRow.anchors_json as any[])
          : null,
        childTextForFallbackAnchors: childText,
      });

      const proposal = {
        proposedParentId: deterministic.proposedParentId,
        ruleId: deterministic.audit.ruleId,
        evidence: deterministic.audit.evidence as any,
      };
      if (matchedAnchorMomentId) {
        (proposal.evidence as any).matchedAnchorMomentId = matchedAnchorMomentId;
      }

      try {
        if (!proposal.proposedParentId) {
          leftUnlinked++;
          await db
            .insertInto("simulation_run_link_decisions")
            .values({
              run_id: input.runId,
              child_moment_id: childMomentId,
              r2_key: r2Key,
              stream_id: streamId,
              macro_index: macroIndex as any,
              phase: "deterministic_linking",
              outcome: "unlinked",
              parent_moment_id: null,
              rule_id: proposal.ruleId,
              evidence_json: JSON.stringify(proposal.evidence),
              created_at: now,
              updated_at: now,
            } as any)
            .onConflict((oc) =>
              oc.columns(["run_id", "child_moment_id"]).doUpdateSet({
                r2_key: r2Key,
                stream_id: streamId,
                macro_index: macroIndex as any,
                phase: "deterministic_linking",
                outcome: "unlinked",
                parent_moment_id: null,
                rule_id: proposal.ruleId,
                evidence_json: JSON.stringify(proposal.evidence),
                updated_at: now,
              } as any)
            )
            .execute();
          if (verbose) {
            await addSimulationRunEvent(context, {
              runId: input.runId,
              level: "debug",
              kind: "item.decision",
              payload: {
                phase: "deterministic_linking",
                r2Key,
                streamId,
                macroIndex,
                childMomentId,
                childTitle: child?.title ?? null,
                childSummary: child?.summary ?? null,
                childIsSubject: child?.isSubject ?? null,
                childSubjectKind: child?.subjectKind ?? null,
                outcome: "unlinked",
                proposedParentId: null,
                ruleId: proposal.ruleId,
              },
            });
          }
          continue;
        }

        const child = momentsMap.get(childMomentId) ?? null;
        if (!child) {
          rejected++;
          proposal.evidence.rejectReason = "missing-child-moment";
          await db
            .insertInto("simulation_run_link_decisions")
            .values({
              run_id: input.runId,
              child_moment_id: childMomentId,
              r2_key: r2Key,
              stream_id: streamId,
              macro_index: macroIndex as any,
              phase: "deterministic_linking",
              outcome: "rejected",
              parent_moment_id: null,
              rule_id: proposal.ruleId,
              evidence_json: JSON.stringify(proposal.evidence),
              created_at: now,
              updated_at: now,
            } as any)
            .onConflict((oc) =>
              oc.columns(["run_id", "child_moment_id"]).doUpdateSet({
                r2_key: r2Key,
                stream_id: streamId,
                macro_index: macroIndex as any,
                phase: "deterministic_linking",
                outcome: "rejected",
                parent_moment_id: null,
                rule_id: proposal.ruleId,
                evidence_json: JSON.stringify(proposal.evidence),
                updated_at: now,
              } as any)
            )
            .execute();
          if (verbose) {
            await addSimulationRunEvent(context, {
              runId: input.runId,
              level: "debug",
              kind: "item.decision",
              payload: {
                phase: "deterministic_linking",
                r2Key,
                streamId,
                macroIndex,
                childMomentId,
                childTitle: null,
                childSummary: null,
                childIsSubject: null,
                childSubjectKind: null,
                outcome: "rejected",
                proposedParentId: null,
                ruleId: proposal.ruleId,
                rejectReason: "missing-child-moment",
              },
            });
          }
          continue;
        }

        const withParent = {
          ...child,
          parentId: proposal.proposedParentId,
          linkAuditLog: {
            kind: "simulation.deterministic_linking",
            ruleId: proposal.ruleId,
            evidence: proposal.evidence,
          },
        };

        await addMoment(withParent as any, momentGraphContext);

        const momentDb = getMomentGraphDb(context.env, effectiveNamespace ?? null);
        const row2 = await momentDb
          .selectFrom("moments")
          .select(["parent_id"])
          .where("id", "=", childMomentId)
          .executeTakeFirst();
        const actual =
          typeof (row2 as any)?.parent_id === "string"
            ? (row2 as any).parent_id
            : null;

        const ok = actual === proposal.proposedParentId;
        if (ok) {
          attached++;
        } else {
          rejected++;
          proposal.evidence.rejectReason = "write_rejected_by_moment_db";
        }

        if (verbose) {
          const parent = proposal.proposedParentId
            ? (momentsMap.get(proposal.proposedParentId) ?? null)
            : null;
          await addSimulationRunEvent(context, {
            runId: input.runId,
            level: "debug",
            kind: "item.decision",
            payload: {
              phase: "deterministic_linking",
              r2Key,
              streamId,
              macroIndex,
              childMomentId,
              childTitle: child?.title ?? null,
              childSummary: child?.summary ?? null,
              childIsSubject: child?.isSubject ?? null,
              childSubjectKind: child?.subjectKind ?? null,
              outcome: ok ? "attached" : "rejected",
              proposedParentId: ok ? proposal.proposedParentId : null,
              parentTitle: parent?.title ?? null,
              parentSummary: parent?.summary ?? null,
              ruleId: proposal.ruleId,
              rejectReason: ok ? null : "write_rejected_by_moment_db",
            },
          });
        }

        await db
          .insertInto("simulation_run_link_decisions")
          .values({
            run_id: input.runId,
            child_moment_id: childMomentId,
            r2_key: r2Key,
            stream_id: streamId,
            macro_index: macroIndex as any,
            phase: "deterministic_linking",
            outcome: ok ? "attached" : "rejected",
            parent_moment_id: ok ? proposal.proposedParentId : null,
            rule_id: proposal.ruleId,
            evidence_json: JSON.stringify(proposal.evidence),
            created_at: now,
            updated_at: now,
          } as any)
          .onConflict((oc) =>
            oc.columns(["run_id", "child_moment_id"]).doUpdateSet({
              r2_key: r2Key,
              stream_id: streamId,
              macro_index: macroIndex as any,
              phase: "deterministic_linking",
              outcome: ok ? "attached" : "rejected",
              parent_moment_id: ok ? proposal.proposedParentId : null,
              rule_id: proposal.ruleId,
              evidence_json: JSON.stringify(proposal.evidence),
              updated_at: now,
            } as any)
          )
          .execute();
      } catch (e) {
        failed++;
        const msg = e instanceof Error ? e.message : String(e);
        await log.error("item.error", {
          phase: "deterministic_linking",
          r2Key,
          streamId,
          macroIndex,
          childMomentId,
          error: msg,
        });
      }
    }
  }

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: failed > 0 ? "error" : "info",
    kind: "phase.end",
    payload: {
      phase: "deterministic_linking",
      momentsProcessed,
      attached,
      rejected,
      leftUnlinked,
      failed,
    },
  });

  if (failed > 0) {
    await db
      .updateTable("simulation_runs")
      .set({
        status: "paused_on_error",
        updated_at: now,
        last_progress_at: now,
        last_error_json: JSON.stringify({
          message: "deterministic_linking failed for one or more items",
        }),
      } as any)
      .where("run_id", "=", input.runId)
      .execute();
    return { status: "paused_on_error", currentPhase: "deterministic_linking" };
  }

  const nextPhase = simulationPhases[input.phaseIdx + 1] ?? null;
  if (!nextPhase) {
    await db
      .updateTable("simulation_runs")
      .set({
        status: "completed",
        updated_at: now,
        last_progress_at: now,
      } as any)
      .where("run_id", "=", input.runId)
      .execute();
    return { status: "completed", currentPhase: "deterministic_linking" };
  }

  await db
    .updateTable("simulation_runs")
    .set({
      current_phase: nextPhase,
      updated_at: now,
      last_progress_at: now,
    } as any)
    .where("run_id", "=", input.runId)
    .execute();

  return { status: "running", currentPhase: nextPhase };
}

