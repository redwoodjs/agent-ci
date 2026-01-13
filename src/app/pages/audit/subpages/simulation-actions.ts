"use server";

import { env } from "cloudflare:workers";
import {
  createSimulationRun,
  advanceSimulationRunPhaseNoop,
  pauseSimulationRunManual,
  resumeSimulationRun,
  restartSimulationRunFromPhase,
  simulationPhases,
} from "@/app/engine/simulationDb";

export async function startSimulationRunAction(input: {
  r2Keys: string[];
  momentGraphNamespace: string | null;
  momentGraphNamespacePrefix: string | null;
}) {
  const runId = crypto.randomUUID();
  const effectiveMomentGraphNamespace =
    input.momentGraphNamespace ?? `sim-${runId}`;
  const cleanedR2Keys = Array.isArray(input.r2Keys)
    ? input.r2Keys.filter((k) => typeof k === "string" && k.trim().length > 0)
    : [];

  await createSimulationRun(
    { env: env as Cloudflare.Env, momentGraphNamespace: null },
    {
      runId,
      momentGraphNamespace: effectiveMomentGraphNamespace,
      momentGraphNamespacePrefix: input.momentGraphNamespacePrefix,
      config: {
        r2Keys: cleanedR2Keys,
        createdFrom: "audit.ui",
      },
    }
  );

  return { success: true, runId };
}

export async function advanceSimulationRunAction(input: { runId: string }) {
  const runId = typeof input.runId === "string" ? input.runId.trim() : "";
  if (!runId) {
    return { success: false, error: "Missing runId" };
  }
  const updated = await advanceSimulationRunPhaseNoop(
    { env: env as Cloudflare.Env, momentGraphNamespace: null },
    { runId }
  );
  if (!updated) {
    return { success: false, error: "Run not found" };
  }
  return { success: true };
}

export async function pauseSimulationRunAction(input: { runId: string }) {
  const runId = typeof input.runId === "string" ? input.runId.trim() : "";
  if (!runId) {
    return { success: false, error: "Missing runId" };
  }
  const ok = await pauseSimulationRunManual(
    { env: env as Cloudflare.Env, momentGraphNamespace: null },
    { runId }
  );
  return ok ? { success: true } : { success: false, error: "Run not found" };
}

export async function resumeSimulationRunAction(input: { runId: string }) {
  const runId = typeof input.runId === "string" ? input.runId.trim() : "";
  if (!runId) {
    return { success: false, error: "Missing runId" };
  }
  const ok = await resumeSimulationRun(
    { env: env as Cloudflare.Env, momentGraphNamespace: null },
    { runId }
  );
  return ok ? { success: true } : { success: false, error: "Run not found" };
}

export async function restartSimulationRunAction(input: {
  runId: string;
  phase: string;
}) {
  const runId = typeof input.runId === "string" ? input.runId.trim() : "";
  if (!runId) {
    return { success: false, error: "Missing runId" };
  }
  const phase =
    typeof input.phase === "string" &&
    simulationPhases.includes(input.phase as any)
      ? (input.phase as any)
      : simulationPhases[0];
  const ok = await restartSimulationRunFromPhase(
    { env: env as Cloudflare.Env, momentGraphNamespace: null },
    { runId, phase }
  );
  return ok ? { success: true } : { success: false, error: "Run not found" };
}
