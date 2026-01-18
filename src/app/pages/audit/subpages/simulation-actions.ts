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

  const keys = Array.from(new Set(allKeysRaw)).filter(filterSupported);
  const skippedCount = allKeysRaw.length - keys.length;

  if (keys.length === 0) {
    return {
      success: false,
      error: `No supported R2 keys found (listed ${
        allKeysRaw.length
      } keys total from prefixes: ${targetPrefixes.join(", ")})`,
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
          prefix: inputPrefix || "(multi)",
          githubRepo: input.githubRepo,
          targetPrefixes,
          limitPerPage,
          maxPages,
          pages: totalPages,
          truncated: isAnyListingTruncated,
          skippedCount,
          sampleStrategy: "all-supported",
        },
      },
    }
  );

  return {
    success: true,
    runId,
    keysCount: keys.length,
    pages: totalPages,
    truncated: isAnyListingTruncated,
    skippedCount,
  };
}

export async function runSampleSimulationRunAction(input: {
  r2Prefix: string;
  githubRepo?: string;
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

  if (supportedKeys.length === 0) {
    return {
      success: false,
      error: `No supported R2 keys found (listed ${allKeysRaw.length} keys total from prefixes: ${targetPrefixes.join(
        ", "
      )})`,
    };
  }

  const keys = (() => {
    const issues = supportedKeys.filter(isGithubIssue);
    const prs = supportedKeys.filter(isGithubPr);
    const discords = supportedKeys.filter(isDiscord);
    const cursors = supportedKeys.filter(isCursor);

    // Shuffle each pool
    const shuffle = (arr: string[]) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
    };
    shuffle(issues);
    shuffle(prs);
    shuffle(discords);
    shuffle(cursors);

    const picked: string[] = [];
    const pools = [issues, prs, discords, cursors];

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

    return picked;
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
