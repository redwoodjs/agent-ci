"use server";

import { env } from "cloudflare:workers";
import {
  createSimulationRun,
  advanceSimulationRunPhaseNoop,
  pauseSimulationRunManual,
  resumeSimulationRun,
  restartSimulationRunFromPhase,
  simulationPhases,
} from "@/app/engine/databases/simulationState";

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

export async function runAllSimulationRunAction(input: {
  r2Prefix: string;
  limitPerPage: number;
  maxPages: number;
  momentGraphNamespace: string | null;
  momentGraphNamespacePrefix: string | null;
}) {
  const envCloudflare = env as Cloudflare.Env;
  const bucket = (envCloudflare as any).MACHINEN_BUCKET as R2Bucket | undefined;
  if (!bucket) {
    return { success: false, error: "MACHINEN_BUCKET binding not found" };
  }

  const prefix = typeof input.r2Prefix === "string" ? input.r2Prefix : "";
  const limitPerPageRaw = input.limitPerPage;
  const limitPerPage =
    typeof limitPerPageRaw === "number" && Number.isFinite(limitPerPageRaw)
      ? Math.max(1, Math.min(200, Math.floor(limitPerPageRaw)))
      : 200;
  const maxPagesRaw = input.maxPages;
  const maxPages =
    typeof maxPagesRaw === "number" && Number.isFinite(maxPagesRaw)
      ? Math.max(1, Math.min(25, Math.floor(maxPagesRaw)))
      : 5;

  const keysRaw: string[] = [];
  let cursor: string | undefined = undefined;
  let truncated = true;
  let pages = 0;

  while (truncated && pages < maxPages) {
    const res = await bucket.list({ prefix, cursor, limit: limitPerPage });
    for (const o of res.objects) {
      const k = typeof (o as any)?.key === "string" ? ((o as any).key as string) : "";
      if (k) {
        keysRaw.push(k);
      }
    }
    cursor = (res as any).cursor as string | undefined;
    truncated = Boolean(res.truncated);
    pages++;
  }

  const supportedPrefixes = ["github/", "discord/", "cursor/conversations/"];
  const keys = Array.from(new Set(keysRaw)).filter((k) =>
    supportedPrefixes.some((p) => k.startsWith(p))
  );
  const skippedCount = keysRaw.length - keys.length;
  if (keys.length === 0) {
    return {
      success: false,
      error: `No supported R2 keys found in the listed set (supported prefixes: ${supportedPrefixes.join(
        ", "
      )})`,
    };
  }

  const runId = crypto.randomUUID();
  const effectiveMomentGraphNamespace =
    input.momentGraphNamespace ?? `sim-${runId}`;

  await createSimulationRun(
    { env: envCloudflare, momentGraphNamespace: null },
    {
      runId,
      momentGraphNamespace: effectiveMomentGraphNamespace,
      momentGraphNamespacePrefix: input.momentGraphNamespacePrefix,
      config: {
        r2Keys: keys,
        createdFrom: "audit.ui.run_all",
        r2List: {
          prefix,
          limitPerPage,
          maxPages,
          pages,
          truncated,
          supportedPrefixes,
          skippedCount,
        },
      },
    }
  );

  return {
    success: true,
    runId,
    keysCount: keys.length,
    pages,
    truncated,
    skippedCount,
  };
}

export async function runSampleSimulationRunAction(input: {
  r2Prefix: string;
  limitPerPage: number;
  maxPages: number;
  sampleSize: number;
  momentGraphNamespace: string | null;
  momentGraphNamespacePrefix: string | null;
}) {
  const envCloudflare = env as Cloudflare.Env;
  const bucket = (envCloudflare as any).MACHINEN_BUCKET as R2Bucket | undefined;
  if (!bucket) {
    return { success: false, error: "MACHINEN_BUCKET binding not found" };
  }

  const prefix = typeof input.r2Prefix === "string" ? input.r2Prefix : "";
  const limitPerPageRaw = input.limitPerPage;
  const limitPerPage =
    typeof limitPerPageRaw === "number" && Number.isFinite(limitPerPageRaw)
      ? Math.max(1, Math.min(200, Math.floor(limitPerPageRaw)))
      : 200;
  const maxPagesRaw = input.maxPages;
  const maxPages =
    typeof maxPagesRaw === "number" && Number.isFinite(maxPagesRaw)
      ? Math.max(1, Math.min(25, Math.floor(maxPagesRaw)))
      : 5;
  const sampleSizeRaw = input.sampleSize;
  const sampleSize =
    typeof sampleSizeRaw === "number" && Number.isFinite(sampleSizeRaw)
      ? Math.max(1, Math.min(200, Math.floor(sampleSizeRaw)))
      : 20;

  const allKeysRaw: string[] = [];
  let cursor: string | undefined = undefined;
  let truncated = true;
  let pages = 0;

  while (truncated && pages < maxPages) {
    const res = await bucket.list({ prefix, cursor, limit: limitPerPage });
    for (const o of res.objects) {
      const k = typeof (o as any)?.key === "string" ? ((o as any).key as string) : "";
      if (k) {
        allKeysRaw.push(k);
      }
    }
    cursor = (res as any).cursor as string | undefined;
    truncated = Boolean(res.truncated);
    pages++;
  }

  const supportedPrefixes = ["github/", "discord/", "cursor/conversations/"];
  const supportedKeys = Array.from(new Set(allKeysRaw)).filter((k) =>
    supportedPrefixes.some((p) => k.startsWith(p))
  );
  const skippedCount = allKeysRaw.length - supportedKeys.length;
  if (supportedKeys.length === 0) {
    return {
      success: false,
      error: `No supported R2 keys found in the listed set (supported prefixes: ${supportedPrefixes.join(
        ", "
      )})`,
    };
  }

  const keys = (() => {
    const isGithubIssue = (k: string) =>
      k.startsWith("github/") && k.includes("/issues/");
    const isGithubPr = (k: string) =>
      k.startsWith("github/") && k.includes("/pull-requests/");
    const isDiscord = (k: string) => k.startsWith("discord/");
    const isCursor = (k: string) => k.startsWith("cursor/conversations/");

    const pool = supportedKeys.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }

    const picked: string[] = [];
    const pickedSet = new Set<string>();

    function pickOne(filter: (k: string) => boolean) {
      for (const k of pool) {
        if (!pickedSet.has(k) && filter(k)) {
          picked.push(k);
          pickedSet.add(k);
          return;
        }
      }
    }

    // Mixed sample: ensure each category is represented when available.
    pickOne(isGithubIssue);
    pickOne(isGithubPr);
    pickOne(isDiscord);
    pickOne(isCursor);

    for (const k of pool) {
      if (picked.length >= sampleSize) {
        break;
      }
      if (!pickedSet.has(k)) {
        picked.push(k);
        pickedSet.add(k);
      }
    }

    return picked.slice(0, sampleSize);
  })();

  const runId = crypto.randomUUID();
  const effectiveMomentGraphNamespace =
    input.momentGraphNamespace ?? `sim-${runId}`;

  await createSimulationRun(
    { env: envCloudflare, momentGraphNamespace: null },
    {
      runId,
      momentGraphNamespace: effectiveMomentGraphNamespace,
      momentGraphNamespacePrefix: input.momentGraphNamespacePrefix,
      config: {
        r2Keys: keys,
        createdFrom: "audit.ui.run_sample",
        r2List: {
          prefix,
          limitPerPage,
          maxPages,
          pages,
          truncated,
          sampleSize,
          supportedPrefixes,
          skippedCount,
          sampleStrategy: "mixed-by-source",
        },
      },
    }
  );

  return {
    success: true,
    runId,
    sampledFromCount: supportedKeys.length,
    sampleSize: keys.length,
    pages,
    truncated,
    skippedCount,
  };
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
  return {
    success: true,
    status: (updated as any).status ?? null,
    currentPhase: (updated as any).currentPhase ?? null,
  };
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
