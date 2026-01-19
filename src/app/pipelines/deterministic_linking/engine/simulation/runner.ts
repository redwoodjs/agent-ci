import { applyMomentGraphNamespacePrefixValue } from "../../../../engine/momentGraphNamespace";
import type { SimulationDbContext } from "../../../../engine/simulation/types";
import {
  getMomentGraphDb,
  getSimulationDb,
} from "../../../../engine/simulation/db";
import { addSimulationRunEvent } from "../../../../engine/simulation/runEvents";
import { createSimulationRunLogger } from "../../../../engine/simulation/logger";
import { simulationPhases } from "../../../../engine/simulation/types";
import { addMoment, getMoments, getMomentsForDocument } from "../../../../engine/databases/momentGraph";
import { resolveThreadHeadForDocumentAsOf } from "../../../../engine/core/linking/explicitRefThreadHead";
import { computeDeterministicLinkingDecision } from "../../../../engine/core/linking/deterministicLinkingOrchestrator";

export async function runPhaseDeterministicLinking(
  context: SimulationDbContext,
  input: { runId: string; phaseIdx: number; r2Key?: string }
): Promise<{ status: string; currentPhase: string } | null> {
  const db = getSimulationDb(context);
  const now = new Date().toISOString();
  const log = createSimulationRunLogger(context, { runId: input.runId });
  const verbosityRaw = String((context.env as any).MACHINEN_SIMULATION_EVENT_VERBOSITY ?? "").trim().toLowerCase();
  const verbose = verbosityRaw === "1" || verbosityRaw === "true" || verbosityRaw === "verbose" || verbosityRaw === "item";

  const runRow = (await db
    .selectFrom("simulation_runs")
    .select(["config_json", "moment_graph_namespace", "moment_graph_namespace_prefix"])
    .where("run_id", "=", input.runId)
    .executeTakeFirst()) as any;

  if (!runRow) return null;

  const baseNamespace = runRow.moment_graph_namespace;
  const prefix = runRow.moment_graph_namespace_prefix;
  const effectiveNamespace = baseNamespace && prefix ? applyMomentGraphNamespacePrefixValue(baseNamespace, prefix) : baseNamespace;
  
  const config = runRow.config_json ?? {};
  const r2KeysRaw = config?.r2Keys;
  const r2Keys = Array.isArray(r2KeysRaw) && r2KeysRaw.every((k: any) => typeof k === "string") ? (r2KeysRaw as string[]) : [];

  // Filter to changed documents
  const changedDocs = await db
    .selectFrom("simulation_run_documents")
    .select("r2_key")
    .where("run_id", "=", input.runId)
    .where("changed", "=", 1)
    .where("error_json", "is", null)
    .execute();
  
  const relevantR2Keys = changedDocs.map(d => d.r2_key);

  if (!input.r2Key) {
    if (relevantR2Keys.length === 0) return advance(db, input.runId, input.phaseIdx, now);

    // Done if all relevant docs have entries in link_decisions (at least one check)
    const processedRows = await db
      .selectFrom("simulation_run_link_decisions")
      .select("r2_key")
      .where("run_id", "=", input.runId)
      .where("phase", "=", "deterministic_linking")
      .distinct()
      .execute();
    
    const docDispatchRows = await db
      .selectFrom("simulation_run_documents")
      .select(["r2_key", "dispatched_phases_json"])
      .where("run_id", "=", input.runId)
      .execute();

    const processedSet = new Set(processedRows.map(r => r.r2_key));
    const dispatchMap = new Map(docDispatchRows.map(r => [r.r2_key, JSON.parse(r.dispatched_phases_json || "[]") as string[]]));

    const missingKeys = relevantR2Keys.filter(k => !processedSet.has(k));
    const undecpatchedKeys = relevantR2Keys.filter(k => {
      if (processedSet.has(k)) return false;
      const dispatched = dispatchMap.get(k) || [];
      return !dispatched.includes("deterministic_linking");
    });

    if (undecpatchedKeys.length > 0) {
      const queue = (context.env as any).ENGINE_INDEXING_QUEUE;
      if (queue) {
        await addSimulationRunEvent(context, {
          runId: input.runId,
          level: "info",
          kind: "phase.dispatch_docs",
          payload: { phase: "deterministic_linking", count: undecpatchedKeys.length },
        });

        for (const k of undecpatchedKeys) {
          const dispatched = dispatchMap.get(k) || [];
          const nextDispatched = [...new Set([...dispatched, "deterministic_linking"])];
          
          await db.updateTable("simulation_run_documents")
            .set({ dispatched_phases_json: JSON.stringify(nextDispatched), updated_at: now })
            .where("run_id", "=", input.runId)
            .where("r2_key", "=", k)
            .execute();

          await queue.send({ jobType: "simulation-document", runId: input.runId, phase: "deterministic_linking", r2Key: k });
        }
        return { status: "awaiting_documents", currentPhase: "deterministic_linking" };
      }
      throw new Error("ENGINE_INDEXING_QUEUE is required");
    }

    if (missingKeys.length > 0) {
      return { status: "awaiting_documents", currentPhase: "deterministic_linking" };
    }

    return advance(db, input.runId, input.phaseIdx, now);
  }

  // Granular execution
  const momentGraphContext = { env: context.env, momentGraphNamespace: effectiveNamespace ?? null };
  const moments = await getMomentsForDocument(input.r2Key, momentGraphContext);

  for (const child of moments) {
    if (!child.isSubject) continue;

    const asOfMs = Date.parse(child.createdAt);
    const threadHead = await resolveThreadHeadForDocumentAsOf({
      documentId: input.r2Key,
      asOfMs: Number.isFinite(asOfMs) ? asOfMs : null,
      context: momentGraphContext,
    });

    const proposal = await computeDeterministicLinkingDecision({
      ports: {
        resolveThreadHeadForDocumentAsOf: (args) => resolveThreadHeadForDocumentAsOf({ ...args, context: momentGraphContext }),
      },
      r2Key: input.r2Key,
      streamId: "unknown", // Ideal would be to find the streamId
      macroIndex: 0,
      childMomentId: child.id,
      prevMomentId: null,
      childDocumentId: child.documentId,
      childCreatedAt: child.createdAt,
      childSourceMetadata: (child.sourceMetadata as any) ?? undefined,
      childTextForFallbackAnchors: `${child.title}\n${child.summary}`,
    });

    if (proposal.audit?.kind === "unlinked") {
         await db.insertInto("simulation_run_link_decisions").values({
           run_id: input.runId,
           child_moment_id: child.id,
           r2_key: input.r2Key,
           stream_id: "unknown",
           macro_index: 0,
           phase: "deterministic_linking",
           outcome: "unlinked",
           parent_moment_id: null,
           rule_id: proposal.audit.ruleId ?? "none",
           evidence_json: JSON.stringify(proposal.audit.evidence),
           created_at: now,
           updated_at: now,
         } as any).onConflict(oc => oc.columns(["run_id", "child_moment_id"]).doUpdateSet({ outcome: "unlinked", updated_at: now } as any)).execute();
         continue;
    }

    if (proposal.proposedParentId) {
        await addMoment({ ...child, parentId: proposal.proposedParentId } as any, momentGraphContext);
        await db.insertInto("simulation_run_link_decisions").values({
          run_id: input.runId,
          child_moment_id: child.id,
          r2_key: input.r2Key,
          stream_id: "unknown",
          macro_index: 0,
          phase: "deterministic_linking",
          outcome: "attached",
          parent_moment_id: proposal.proposedParentId,
          rule_id: proposal.audit.ruleId ?? "none",
          evidence_json: JSON.stringify(proposal.audit.evidence),
          created_at: now,
          updated_at: now,
        } as any).onConflict(oc => oc.columns(["run_id", "child_moment_id"]).doUpdateSet({ outcome: "attached", parent_moment_id: proposal.proposedParentId, updated_at: now } as any)).execute();
    }
  }

  // Ensure we have at least one entry to mark this doc as done if it had no subject moments
  if (moments.length === 0 || !moments.some(m => m.isSubject)) {
      await db.insertInto("simulation_run_link_decisions").values({
          run_id: input.runId,
          child_moment_id: `noop-${input.r2Key}`,
          r2_key: input.r2Key,
          stream_id: "none",
          macro_index: 0,
          phase: "deterministic_linking",
          outcome: "noop",
          parent_moment_id: null,
          rule_id: "none",
          evidence_json: "{}",
          created_at: now,
          updated_at: now,
      } as any).onConflict(oc => oc.columns(["run_id", "child_moment_id"]).doUpdateSet({ outcome: "noop", updated_at: now } as any)).execute();
  }

  return { status: "running", currentPhase: "deterministic_linking" };
}

async function advance(db: any, runId: string, phaseIdx: number, now: string) {
  const nextPhase = simulationPhases[phaseIdx + 1] ?? null;
  if (!nextPhase) {
    await db.updateTable("simulation_runs").set({ status: "completed", updated_at: now }).where("run_id", "=", runId).execute();
    return { status: "completed", currentPhase: "deterministic_linking" };
  }
  await db.updateTable("simulation_runs").set({ current_phase: nextPhase, updated_at: now }).where("run_id", "=", runId).execute();
  return { status: "running", currentPhase: nextPhase };
}
