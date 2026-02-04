"use server";

import { env } from "cloudflare:workers";
import { someOf } from "fictional";
import {
  createSimulationRun,
  tickSimulationRun,
  pauseSimulationRunManual,
  resumeSimulationRun,
  restartSimulationRunFromPhase,
  simulationPhases,
  getSimulationRunById,
  getSimulationRunEvents,
} from "@/app/engine/databases/simulationState";

async function listR2KeysHelper(
  bucket: R2Bucket,
  inputPrefix: string,
  maxPages: number,
  limitPerPage: number,
  githubRepo?: string
) {
  const targetPrefixes = inputPrefix
    ? [inputPrefix]
    : [
        githubRepo ? `github/${githubRepo}/` : "github/",
        "discord/",
        "cursor/conversations/",
      ];

  const allKeysRaw: string[] = [];
  let totalPages = 0;
  let isAnyListingTruncated = false;

  for (const p of targetPrefixes) {
    let cursor: string | undefined = undefined;
    let truncated = true;
    let prefixPages = 0;
    const maxPagesForThisPrefix = inputPrefix
      ? maxPages
      : Math.ceil(maxPages / targetPrefixes.length);

    while (truncated && prefixPages < maxPagesForThisPrefix) {
      const res = await bucket.list({ prefix: p, cursor, limit: limitPerPage });
      for (const o of res.objects) {
        const k =
          typeof (o as any)?.key === "string" ? ((o as any).key as string) : "";
        if (k) {
          allKeysRaw.push(k);
        }
      }
      cursor = (res as any).cursor as string | undefined;
      truncated = Boolean(res.truncated);
      if (truncated) {
        isAnyListingTruncated = true;
      }
      prefixPages++;
      totalPages++;
    }
  }

  return { allKeysRaw, totalPages, isAnyListingTruncated, targetPrefixes };
}

export async function startSimulationRunAction(input: {
  r2Keys: string[];
  momentGraphNamespace: string | null;
  momentGraphNamespacePrefix: string | null;
}) {
  try {
    const runId = crypto.randomUUID();
    const effectiveMomentGraphNamespace = input.momentGraphNamespace ?? null;
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
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function runAllSimulationRunAction(input: {
  r2Prefix: string;
  githubRepo?: string;
  limitPerPage: number;
  maxPages: number;
  momentGraphNamespace: string | null;
  momentGraphNamespacePrefix: string | null;
}) {
  try {
    const envCloudflare = env as Cloudflare.Env;
    // We don't need bucket here anymore as we don't list
    
    const inputPrefix =
      typeof input.r2Prefix === "string" ? input.r2Prefix.trim() : "";
    const limitPerPageRaw = input.limitPerPage;
    const limitPerPage =
      typeof limitPerPageRaw === "number" && Number.isFinite(limitPerPageRaw)
        ? Math.max(1, Math.min(1000, Math.floor(limitPerPageRaw)))
        : 200;
    const maxPagesRaw = input.maxPages;
    const maxPages =
      typeof maxPagesRaw === "number" && Number.isFinite(maxPagesRaw)
        ? Math.max(1, Math.min(10000, Math.floor(maxPagesRaw)))
        : 100;

    // Reconstruct target prefixes logic
    const targetPrefixes = inputPrefix
      ? [inputPrefix]
      : [
          input.githubRepo ? `github/${input.githubRepo}/` : "github/",
          "discord/",
          "cursor/conversations/",
        ];

    const runId = crypto.randomUUID();
    const effectiveMomentGraphNamespace =
      input.momentGraphNamespace ?? null;

    await createSimulationRun(
      { env: envCloudflare, momentGraphNamespace: null },
      {
        runId,
        momentGraphNamespace: effectiveMomentGraphNamespace,
        momentGraphNamespacePrefix: input.momentGraphNamespacePrefix,
        config: {
          r2Keys: [], // Empty, will be populated by r2_listing phase into DB
          createdFrom: "audit.ui.run_all.v2_async_listing",
          r2List: {
            prefix: inputPrefix || "(multi)",
            targetPrefixes,
            limitPerPage,
            maxPages,
            // Initial state
            currentPrefixIdx: 0,
            pagesProcessed: 0,
          },
        },
      }
    );

    return {
      success: true,
      runId,
      keysCount: 0, // Unknown yet
      pages: 0,
      truncated: false, 
      skippedCount: 0,
      message: "Simulation started with async R2 listing",
    };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function runSampleSimulationRunAction(input: {
  r2Prefix: string;
  githubRepo?: string;
  limitPerPage: number;
  maxPages: number;
  sampleSize: number;
  momentGraphNamespace: string | null;
  momentGraphNamespacePrefix: string | null;
  seed?: string;
  additionalR2Keys?: string[];
}) {
  const envCloudflare = env as Cloudflare.Env;
  const bucket = (envCloudflare as any).MACHINEN_BUCKET as R2Bucket | undefined;
  if (!bucket) {
    return { success: false, error: "MACHINEN_BUCKET binding not found" };
  }

  const inputPrefix =
    typeof input.r2Prefix === "string" ? input.r2Prefix.trim() : "";

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

  const { allKeysRaw, totalPages, isAnyListingTruncated, targetPrefixes } =
    await listR2KeysHelper(
      bucket,
      inputPrefix,
      maxPages,
      limitPerPage,
      input.githubRepo
    );

  const isGithubIssue = (k: string) =>
    k.startsWith("github/") &&
    k.includes("/issues/") &&
    k.endsWith("/latest.json");
  const isGithubPr = (k: string) =>
    k.startsWith("github/") &&
    k.includes("/pull-requests/") &&
    k.endsWith("/latest.json");
  const isDiscord = (k: string) => k.startsWith("discord/");
  const isCursor = (k: string) => k.startsWith("cursor/conversations/");

  const filterSupported = (k: string) =>
    isGithubIssue(k) || isGithubPr(k) || isDiscord(k) || isCursor(k);

  const supportedKeys = Array.from(new Set(allKeysRaw)).filter(filterSupported);
  const skippedCount = allKeysRaw.length - supportedKeys.length;

  if (supportedKeys.length === 0 && (!input.additionalR2Keys || input.additionalR2Keys.length === 0)) {
    return {
      success: false,
      error: `No supported R2 keys found (listed ${allKeysRaw.length} keys total from prefixes: ${targetPrefixes.join(
        ", "
      )})`,
    };
  }

  const seed = input.seed || crypto.randomUUID();

  const keys = (() => {
    const issues = supportedKeys.filter(isGithubIssue);
    const prs = supportedKeys.filter(isGithubPr);
    const discords = supportedKeys.filter(isDiscord);
    const cursors = supportedKeys.filter(isCursor);

    // Deterministically shuffle each pool using fictional
    const shuffledIssues = someOf(seed + ":issues", issues.length, issues);
    const shuffledPrs = someOf(seed + ":prs", prs.length, prs);
    const shuffledDiscords = someOf(seed + ":discords", discords.length, discords);
    const shuffledCursors = someOf(seed + ":cursors", cursors.length, cursors);

    const picked: string[] = [];
    const pools = [shuffledIssues, shuffledPrs, shuffledDiscords, shuffledCursors];

    // Priority 1: Pick at least one from each non-empty pool
    for (const pool of pools) {
      if (pool.length > 0) {
        picked.push(pool.pop()!);
      }
    }

    // Priority 2: Round-robin pick remaining until sampleSize or all exhausted
    let poolIdx = 0;
    while (picked.length < sampleSize) {
      const startIdx = poolIdx;
      let pickedInThisRound = false;

      for (let i = 0; i < pools.length; i++) {
        const currentPool = pools[(startIdx + i) % pools.length];
        if (currentPool.length > 0) {
          picked.push(currentPool.pop()!);
          pickedInThisRound = true;
          poolIdx = (startIdx + i + 1) % pools.length;
          if (picked.length >= sampleSize) {
            break;
          }
        }
      }

      if (!pickedInThisRound) {
        break;
      }
    }

    // Combine with manual keys and shuffle
    const manualKeys = Array.isArray(input.additionalR2Keys) ? input.additionalR2Keys : [];
    const combined = Array.from(new Set([...manualKeys, ...picked]));
    
    // someOf(seed, length, array) effectively shuffles when length === array.length
    return someOf(seed + ":mixed_shuffle", combined.length, combined);
  })();

  const runId = crypto.randomUUID();
  const effectiveMomentGraphNamespace =
    input.momentGraphNamespace ?? null;

  await createSimulationRun(
    { env: envCloudflare, momentGraphNamespace: null },
    {
      runId,
      momentGraphNamespace: effectiveMomentGraphNamespace,
      momentGraphNamespacePrefix: input.momentGraphNamespacePrefix,
      config: {
        r2Keys: keys,
        createdFrom: "audit.ui.run_sample",
        seed,
        r2List: {
          prefix: inputPrefix || "(multi)",
          targetPrefixes,
          limitPerPage,
          maxPages,
          pages: totalPages,
          truncated: isAnyListingTruncated,
          sampleSize,
          skippedCount,
          sampleStrategy: "balanced-round-robin",
        },
      },
    }
  );

  return {
    success: true,
    runId,
    sampledFromCount: supportedKeys.length,
    sampleSize: keys.length,
    pages: totalPages,
    truncated: isAnyListingTruncated,
    skippedCount,
  };
}

export async function advanceSimulationRunAction(input: { runId: string }) {
  const runId = typeof input.runId === "string" ? input.runId.trim() : "";
  if (!runId) {
    return { success: false, error: "Missing runId" };
  }
  const updated = await tickSimulationRun(
    { env: env as Cloudflare.Env, momentGraphNamespace: null },
    { runId }
  );
  if (!updated) {
    return { success: false, error: "Run not found" };
  }
  if (updated.status === "busy_running") {
    return { success: false, error: "Run is already busy processing a phase" };
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

export async function autoAdvanceSimulationRunAction(input: {
  runId: string;
  maxMs?: number;
  continueOnError?: boolean;
}) {
  const runId = typeof input.runId === "string" ? input.runId.trim() : "";
  if (!runId) {
    return { success: false, error: "Missing runId" };
  }
  try {
    const { autoAdvanceSimulationRun } = await import(
      "@/app/engine/runners/simulation/runner"
    );
    const result = await autoAdvanceSimulationRun(
      { env: env as Cloudflare.Env, momentGraphNamespace: null },
      { runId, maxMs: input.maxMs, continueOnError: input.continueOnError }
    );
    return {
      success: true,
      status: result.status,
      currentPhase: result.currentPhase,
      steps: result.steps,
    };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function normalizePayload(payload: unknown): unknown {
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch {
      return payload;
    }
  }
  return payload;
}

function formatEventsAsText(
  events: Array<{
    createdAt: string;
    level: string;
    kind: string;
    payload: any;
  }>
): string {
  const chronological = [...events].reverse();
  const lines: string[] = [];
  for (const e of chronological) {
    const payload = normalizePayload(e.payload);
    const payloadOneLine = (() => {
      try {
        return JSON.stringify(payload);
      } catch {
        return String(payload);
      }
    })();
    lines.push(`${e.createdAt} [${e.level}] ${e.kind} ${payloadOneLine}`);
  }
  return lines.join("\n");
}

export async function getSimulationRunLogStateAction(input: { runId: string }) {
  const runId = typeof input.runId === "string" ? input.runId.trim() : "";
  if (!runId) {
    return { success: false, error: "Missing runId" };
  }
  const context = { env: env as Cloudflare.Env, momentGraphNamespace: null };

  const [run, eventsRes] = await Promise.all([
    getSimulationRunById(context, { runId }),
    getSimulationRunEvents(context, { runId, limit: 2000 }),
  ]);

  if (!run) {
    return { success: false, error: "Run not found" };
  }

  const eventsText = formatEventsAsText(eventsRes);
  
  return {
    success: true,
    data: {
      checkTime: new Date().toISOString(),
      run,
      eventsText,
    }
  };
}
