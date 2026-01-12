import type {
  Document,
  IndexingHookContext,
  MacroMomentDescription,
  Moment,
} from "../types";
import { createEngineContext } from "../index";
import { addMoment, findMomentByMicroPathsHash } from "../momentDb";
import { getEmbeddings } from "../utils/vector";
import {
  fetchReplayItemsBatch,
  getReplayCursor,
  getReplayRunOrder,
  getReplayRunStatus,
  getReplayStreamState,
  addReplayRunEvent,
  markReplayItemsDone,
  markReplayItemFailedAndPauseRun,
  pauseReplayRunOnError,
  setReplayCursor,
  setReplayCursorWithTelemetry,
  setReplayEnqueuedFlag,
  setReplayRunStatus,
  setReplayStreamState,
} from "../db/momentReplay";

type ReplayMessage = {
  jobType?: unknown;
  momentReplayRunId?: unknown;
  momentGraphNamespace?: unknown;
  momentGraphNamespacePrefix?: unknown;
};

function sleep(ms: number): Promise<void> {
  const safeMs =
    typeof ms === "number" && Number.isFinite(ms) && ms > 0
      ? Math.floor(ms)
      : 0;
  if (safeMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, safeMs));
}

function envNumber(env: Cloudflare.Env, key: string): number | null {
  const raw = (env as any)[key];
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isRetryableUpstreamError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes("429")) {
    return true;
  }
  if (lower.includes("rate limit")) {
    return true;
  }
  if (lower.includes("timeout")) {
    return true;
  }
  if (lower.includes("timed out")) {
    return true;
  }
  if (lower.includes("overloaded")) {
    return true;
  }
  if (lower.includes("temporarily unavailable")) {
    return true;
  }
  return false;
}

function computeBackoffMs(env: Cloudflare.Env, attempt: number): number {
  const base = envNumber(env, "MOMENT_REPLAY_RETRY_BASE_MS") ?? 1000;
  const max = envNumber(env, "MOMENT_REPLAY_RETRY_MAX_MS") ?? 30000;
  const jitter = envNumber(env, "MOMENT_REPLAY_RETRY_JITTER_MS") ?? 250;
  const exp = Math.max(0, Math.floor(attempt));
  const raw = Math.floor(base * Math.pow(2, exp));
  const capped = Math.min(max, Math.max(0, raw));
  const j =
    typeof jitter === "number" && Number.isFinite(jitter) && jitter > 0
      ? Math.floor(Math.random() * jitter)
      : 0;
  return capped + j;
}

async function hashMicroPaths(
  microPaths: string[]
): Promise<string | undefined> {
  if (microPaths.length === 0) {
    return undefined;
  }
  const encoder = new TextEncoder();
  const data = encoder.encode(microPaths.join("\n"));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function inferDocumentSource(documentId: string): Document["source"] {
  if (documentId.startsWith("github/")) {
    return "github";
  }
  if (documentId.startsWith("discord/")) {
    return "discord";
  }
  if (documentId.startsWith("cursor/")) {
    return "cursor";
  }
  return "meeting-notes";
}

export async function processMomentReplayReplayJob(
  message: ReplayMessage,
  env: Cloudflare.Env
): Promise<void> {
  const runIdRaw = message.momentReplayRunId;
  const runId =
    typeof runIdRaw === "string" && runIdRaw.trim().length > 0
      ? runIdRaw.trim()
      : null;
  if (!runId) {
    return;
  }

  const batchStartedAt = Date.now();

  try {
    console.log("[moment-replay] replay start", { runId });

    await setReplayEnqueuedFlag(
      { env, momentGraphNamespace: null },
      { runId, replayEnqueued: false }
    );
    await addReplayRunEvent(
      { env, momentGraphNamespace: null },
      {
        runId,
        level: "info",
        kind: "worker.start",
        payload: {},
      }
    );

    const currentStatus = await getReplayRunStatus(
      { env, momentGraphNamespace: null },
      { runId }
    );
    if (currentStatus === "paused_on_error") {
      await addReplayRunEvent(
        { env, momentGraphNamespace: null },
        { runId, level: "warn", kind: "worker.skipped_paused", payload: {} }
      );
      console.log("[moment-replay] replay run is paused_on_error, skipping", {
        runId,
      });
      return;
    }

    await setReplayRunStatus(
      { env, momentGraphNamespace: null },
      { runId, status: "replaying" }
    );

    const cursor = (await getReplayCursor(
      { env, momentGraphNamespace: null },
      { runId }
    )) ?? { lastOrderMs: null, lastItemId: null };

    const replayOrder = await getReplayRunOrder(
      { env, momentGraphNamespace: null },
      { runId }
    );

    const batchSizeRaw = (env as any).MOMENT_REPLAY_REPLAY_BATCH_SIZE;
    const batchSize =
      typeof batchSizeRaw === "number" &&
      Number.isFinite(batchSizeRaw) &&
      batchSizeRaw > 0
        ? Math.floor(batchSizeRaw)
        : typeof batchSizeRaw === "string" &&
          batchSizeRaw.trim().length > 0 &&
          Number.isFinite(Number(batchSizeRaw))
        ? Math.max(1, Math.floor(Number(batchSizeRaw)))
        : 10;

    const items = await fetchReplayItemsBatch(
      { env, momentGraphNamespace: null },
      { runId, cursor, limit: batchSize, replayOrder }
    );

    if (items.length === 0) {
      await setReplayRunStatus(
        { env, momentGraphNamespace: null },
        { runId, status: "completed" }
      );
      await addReplayRunEvent(
        { env, momentGraphNamespace: null },
        { runId, level: "info", kind: "worker.completed", payload: {} }
      );
      console.log("[moment-replay] replay complete", { runId });
      return;
    }

    await addReplayRunEvent(
      { env, momentGraphNamespace: null },
      {
        runId,
        level: "info",
        kind: "worker.fetched_batch",
        payload: { batchSize, fetched: items.length, replayOrder },
      }
    );

    const engineContext = createEngineContext(env, "indexing");

    let lastOrderMs: number | null = cursor.lastOrderMs;
    let lastItemId: string | null = cursor.lastItemId;

    const momentsToAdd: Moment[] = [];
    const momentContexts: Array<{
      env: Cloudflare.Env;
      momentGraphNamespace: string | null;
    }> = [];
    const itemIdToMomentId = new Map<string, string>();
    const orderMsByItemId = new Map<string, number>();
    const itemMetaByItemId = new Map<
      string,
      {
        documentId: string;
        effectiveNamespace: string;
        orderMs: number;
        timelineFitCallsDelta: number;
        timelineFitTotalMsDelta: number;
      }
    >();
    for (const it of items) {
      if (typeof it?.itemId === "string" && it.itemId.length > 0) {
        orderMsByItemId.set(it.itemId, it.orderMs);
      }
    }

    for (const item of items) {
      const payload = item.payload ?? {};
      const effectiveNamespace =
        typeof item.effectiveNamespace === "string" &&
        item.effectiveNamespace.trim().length > 0
          ? item.effectiveNamespace.trim()
          : typeof (payload as any)?.effectiveNamespace === "string" &&
            (payload as any).effectiveNamespace.trim().length > 0
          ? (payload as any).effectiveNamespace.trim()
          : "redwood:internal";
      const momentGraphContext = {
        env,
        momentGraphNamespace: effectiveNamespace,
      };
      const doc = (payload as any).document ?? {};
      const documentId =
        typeof doc.id === "string" && doc.id.length > 0 ? doc.id : null;
      if (!documentId) {
        continue;
      }

      const streamIdRaw = (payload as any).streamId;
      const streamId =
        typeof streamIdRaw === "string" && streamIdRaw.length > 0
          ? streamIdRaw
          : "stream-1";
      const macroMomentIndexRaw = (payload as any).macroMomentIndex;
      const macroMomentIndex =
        typeof macroMomentIndexRaw === "number" &&
        Number.isFinite(macroMomentIndexRaw) &&
        macroMomentIndexRaw >= 0
          ? Math.floor(macroMomentIndexRaw)
          : 0;
      const prevItemIdRaw = (payload as any).prevItemId;
      const prevItemId =
        typeof prevItemIdRaw === "string" && prevItemIdRaw.length > 0
          ? prevItemIdRaw
          : null;

      const momentPayload = (payload as any).moment ?? {};
      const title =
        typeof momentPayload.title === "string" ? momentPayload.title : "";
      const summary =
        typeof momentPayload.summary === "string" ? momentPayload.summary : "";
      const author =
        typeof momentPayload.author === "string"
          ? momentPayload.author
          : "unknown";
      const createdAt =
        typeof momentPayload.createdAt === "string" &&
        momentPayload.createdAt.length > 0
          ? momentPayload.createdAt
          : new Date().toISOString();
      const importance =
        typeof momentPayload.importance === "number"
          ? momentPayload.importance
          : undefined;
      const momentKind =
        typeof momentPayload.momentKind === "string"
          ? momentPayload.momentKind
          : undefined;
      const momentEvidence = Array.isArray(momentPayload.momentEvidence)
        ? momentPayload.momentEvidence.filter(
            (e: unknown): e is string => typeof e === "string"
          )
        : undefined;
      const isSubject =
        typeof momentPayload.isSubject === "boolean"
          ? momentPayload.isSubject
          : false;
      const subjectKind =
        typeof momentPayload.subjectKind === "string"
          ? momentPayload.subjectKind
          : undefined;
      const subjectReason =
        typeof momentPayload.subjectReason === "string"
          ? momentPayload.subjectReason
          : undefined;
      const subjectEvidence = Array.isArray(momentPayload.subjectEvidence)
        ? momentPayload.subjectEvidence.filter(
            (e: unknown): e is string => typeof e === "string"
          )
        : undefined;
      const microPaths = Array.isArray(momentPayload.microPaths)
        ? momentPayload.microPaths.filter(
            (p: unknown): p is string => typeof p === "string"
          )
        : [];
      const sourceMetadata =
        typeof momentPayload.sourceMetadata === "object" &&
        momentPayload.sourceMetadata
          ? momentPayload.sourceMetadata
          : undefined;

      const microPathsHash = await hashMicroPaths(microPaths);

      let parentId: string | undefined = undefined;
      let linkAuditLog: Record<string, any> | undefined = undefined;

      if (macroMomentIndex > 0) {
        const resolvedPrevFromBatch =
          prevItemId && itemIdToMomentId.has(prevItemId)
            ? itemIdToMomentId.get(prevItemId) ?? null
            : null;
        if (resolvedPrevFromBatch) {
          parentId = resolvedPrevFromBatch;
        } else {
          const prev = await getReplayStreamState(
            { env, momentGraphNamespace: null },
            { runId, effectiveNamespace, documentId, streamId }
          );
          parentId = prev ?? prevItemId ?? undefined;
        }
      } else {
        const document: Document = {
          id: documentId,
          source: inferDocumentSource(documentId),
          type: typeof doc.type === "string" ? (doc.type as any) : "unknown",
          content: "",
          metadata: {
            title: "",
            url: "",
            createdAt: createdAt,
            author: author,
            ...(typeof (doc as any).sourceMetadata === "object" &&
            (doc as any).sourceMetadata
              ? { sourceMetadata: (doc as any).sourceMetadata }
              : null),
          },
        };

        const macroMoment: MacroMomentDescription = {
          title,
          summary,
          content: summary,
          author,
          createdAt,
          microPaths,
          ...(typeof importance === "number" ? { importance } : null),
          ...(sourceMetadata ? { sourceMetadata } : null),
        } as any;

        const indexingContext: IndexingHookContext = {
          r2Key: documentId,
          env,
          momentGraphNamespace: effectiveNamespace,
          indexingMode: "replay",
        };

        const timelineFitMaxAttempts =
          envNumber(env, "MOMENT_REPLAY_TIMELINE_FIT_MAX_ATTEMPTS") ?? 3;
        const timelineFitStart = Date.now();
        let timelineFitError: unknown = null;
        for (let attempt = 0; attempt < timelineFitMaxAttempts; attempt++) {
          try {
            for (const plugin of engineContext.plugins) {
              const propose = plugin.subjects?.proposeMacroMomentParent;
              if (!propose) {
                continue;
              }
              const attemptResult = await propose(
                document,
                macroMoment,
                0,
                indexingContext
              );
              if (attemptResult?.auditLog && !linkAuditLog) {
                linkAuditLog = attemptResult.auditLog;
              }
              if (attemptResult?.parentMomentId) {
                parentId = attemptResult.parentMomentId ?? undefined;
                if (attemptResult.auditLog) {
                  linkAuditLog = attemptResult.auditLog;
                }
                break;
              }
            }
            timelineFitError = null;
            break;
          } catch (error) {
            timelineFitError = error;
            const retryable = isRetryableUpstreamError(error);
            console.error("[moment-replay] timeline fit failed", {
              runId,
              itemId: item.itemId,
              attempt,
              retryable,
              error: error instanceof Error ? error.message : String(error),
            });
            if (!retryable || attempt + 1 >= timelineFitMaxAttempts) {
              await markReplayItemFailedAndPauseRun(
                { env, momentGraphNamespace: null },
                {
                  runId,
                  itemId: item.itemId,
                  errorPayload: {
                    phase: "timeline-fit",
                    retryable,
                    attempt,
                    message:
                      error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : null,
                  },
                  item: {
                    documentId,
                    effectiveNamespace,
                    orderMs: item.orderMs,
                  },
                }
              );
              return;
            }
            const waitMs = computeBackoffMs(env, attempt);
            await sleep(waitMs);
          }
        }

        if (timelineFitError) {
          await markReplayItemFailedAndPauseRun(
            { env, momentGraphNamespace: null },
            {
              runId,
              itemId: item.itemId,
              errorPayload: {
                phase: "timeline-fit",
                retryable: isRetryableUpstreamError(timelineFitError),
                message:
                  timelineFitError instanceof Error
                    ? timelineFitError.message
                    : String(timelineFitError),
                stack:
                  timelineFitError instanceof Error
                    ? timelineFitError.stack
                    : null,
              },
              item: {
                documentId,
                effectiveNamespace,
                orderMs: item.orderMs,
              },
            }
          );
          return;
        }

        const timelineFitMs = Math.max(0, Date.now() - timelineFitStart);
        if (!linkAuditLog) {
          linkAuditLog = {
            kind: "no-plugin-attempts",
            documentId,
            streamId,
            macroMomentIndex: 0,
          };
        }
        itemMetaByItemId.set(item.itemId, {
          documentId,
          effectiveNamespace,
          orderMs: item.orderMs,
          timelineFitCallsDelta: 1,
          timelineFitTotalMsDelta: timelineFitMs,
        });
      }

      const momentId = item.itemId;
      const moment: Moment = {
        id: momentId,
        documentId,
        title,
        summary,
        author,
        createdAt,
        parentId,
        microPaths,
        microPathsHash,
        ...(linkAuditLog ? { linkAuditLog } : null),
        ...(typeof importance === "number" ? { importance } : null),
        ...(typeof momentKind === "string"
          ? { momentKind: momentKind as any }
          : null),
        ...(momentEvidence ? { momentEvidence } : null),
        ...(isSubject ? { isSubject: true } : null),
        ...(typeof subjectKind === "string"
          ? { subjectKind: subjectKind as any }
          : null),
        ...(typeof subjectReason === "string" ? { subjectReason } : null),
        ...(subjectEvidence ? { subjectEvidence } : null),
        ...(sourceMetadata ? { sourceMetadata } : null),
      };

      momentsToAdd.push(moment);
      momentContexts.push(momentGraphContext);

      if (!itemMetaByItemId.has(item.itemId)) {
        itemMetaByItemId.set(item.itemId, {
          documentId,
          effectiveNamespace,
          orderMs: item.orderMs,
          timelineFitCallsDelta: 0,
          timelineFitTotalMsDelta: 0,
        });
      }

      await setReplayStreamState(
        { env, momentGraphNamespace: null },
        {
          runId,
          effectiveNamespace,
          documentId,
          streamId,
          lastMomentId: momentId,
        }
      );
    }

    if (momentsToAdd.length > 0) {
      let embeddings: number[][] = [];
      const embeddingMaxAttempts =
        envNumber(env, "MOMENT_REPLAY_EMBEDDING_MAX_ATTEMPTS") ?? 3;
      const embeddingStart = Date.now();
      for (let attempt = 0; attempt < embeddingMaxAttempts; attempt++) {
        try {
          embeddings = await getEmbeddings(momentsToAdd.map((m) => m.summary));
          break;
        } catch (error) {
          const retryable = isRetryableUpstreamError(error);
          console.error("[moment-replay] embedding batch failed", {
            runId,
            count: momentsToAdd.length,
            attempt,
            retryable,
            error: error instanceof Error ? error.message : String(error),
          });
          if (!retryable || attempt + 1 >= embeddingMaxAttempts) {
            await addReplayRunEvent(
              { env, momentGraphNamespace: null },
              {
                runId,
                level: "error",
                kind: "worker.embedding_failed",
                payload: {
                  retryable,
                  attempt,
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              }
            );
            await pauseReplayRunOnError(
              { env, momentGraphNamespace: null },
              {
                runId,
                errorPayload: {
                  phase: "embedding",
                  retryable,
                  attempt,
                  message:
                    error instanceof Error ? error.message : String(error),
                  stack: error instanceof Error ? error.stack : null,
                },
              }
            );
            return;
          }
          const waitMs = computeBackoffMs(env, attempt);
          await sleep(waitMs);
        }
      }
      const embeddingMs = Math.max(0, Date.now() - embeddingStart);
      for (let i = 0; i < momentsToAdd.length; i++) {
        const m = momentsToAdd[i]!;
        const ctx = momentContexts[i]!;
        const embedding = embeddings[i] ?? null;
        const meta = itemMetaByItemId.get(m.id) ?? null;
        const perfEmbeddingCallsDelta = i === 0 ? 1 : 0;
        const perfEmbeddingTotalMsDelta = i === 0 ? embeddingMs : 0;
        try {
          const writeStart = Date.now();
          await addMoment(m, ctx, { embedding });
          const writeMs = Math.max(0, Date.now() - writeStart);
          itemIdToMomentId.set(m.id, m.id);
          const orderMs = orderMsByItemId.get(m.id) ?? null;
          await markReplayItemsDone(
            { env, momentGraphNamespace: null },
            { runId, itemIds: [m.id] }
          );
          await setReplayCursorWithTelemetry(
            { env, momentGraphNamespace: null },
            {
              runId,
              cursor: { lastOrderMs: orderMs, lastItemId: m.id },
              replayedItemsDelta: 1,
              lastItem: {
                documentId: meta?.documentId ?? m.documentId,
                effectiveNamespace:
                  meta?.effectiveNamespace ?? ctx.momentGraphNamespace,
              },
              perf: {
                embeddingCallsDelta: perfEmbeddingCallsDelta,
                embeddingTotalMsDelta: perfEmbeddingTotalMsDelta,
                timelineFitCallsDelta: meta?.timelineFitCallsDelta ?? 0,
                timelineFitTotalMsDelta: meta?.timelineFitTotalMsDelta ?? 0,
                dbWritesDelta: 1,
                dbWritesTotalMsDelta: writeMs,
              },
            }
          );
          lastOrderMs = orderMs;
          lastItemId = m.id;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (
            msg.includes(
              "UNIQUE constraint failed: moments.document_id, moments.micro_paths_hash"
            ) &&
            typeof m.documentId === "string" &&
            typeof m.microPathsHash === "string" &&
            m.microPathsHash.length > 0
          ) {
            const existing = await findMomentByMicroPathsHash(
              m.documentId,
              m.microPathsHash,
              ctx
            );
            if (existing?.id) {
              itemIdToMomentId.set(m.id, existing.id);
              const payload = (items.find((it) => it.itemId === m.id)
                ?.payload ?? {}) as any;
              const streamId =
                typeof payload?.streamId === "string" &&
                payload.streamId.length > 0
                  ? payload.streamId
                  : "stream-1";
              await setReplayStreamState(
                { env, momentGraphNamespace: null },
                {
                  runId,
                  effectiveNamespace:
                    ctx.momentGraphNamespace ?? "redwood:internal",
                  documentId: m.documentId,
                  streamId,
                  lastMomentId: existing.id,
                }
              );
              const orderMs = orderMsByItemId.get(m.id) ?? null;
              await markReplayItemsDone(
                { env, momentGraphNamespace: null },
                { runId, itemIds: [m.id] }
              );
              await setReplayCursorWithTelemetry(
                { env, momentGraphNamespace: null },
                {
                  runId,
                  cursor: { lastOrderMs: orderMs, lastItemId: m.id },
                  replayedItemsDelta: 1,
                  lastItem: {
                    documentId: meta?.documentId ?? m.documentId,
                    effectiveNamespace:
                      meta?.effectiveNamespace ?? ctx.momentGraphNamespace,
                  },
                  perf: {
                    embeddingCallsDelta: perfEmbeddingCallsDelta,
                    embeddingTotalMsDelta: perfEmbeddingTotalMsDelta,
                    timelineFitCallsDelta: meta?.timelineFitCallsDelta ?? 0,
                    timelineFitTotalMsDelta: meta?.timelineFitTotalMsDelta ?? 0,
                    dbWritesDelta: 0,
                    dbWritesTotalMsDelta: 0,
                  },
                }
              );
              lastOrderMs = orderMs;
              lastItemId = m.id;
              continue;
            }
          }
          const retryable = isRetryableUpstreamError(error);
          const maxAttempts =
            envNumber(env, "MOMENT_REPLAY_ITEM_MAX_ATTEMPTS") ?? 3;

          await addReplayRunEvent(
            { env, momentGraphNamespace: null },
            {
              runId,
              level: retryable ? "warn" : "error",
              kind: "worker.item_error",
              payload: {
                itemId: m.id,
                retryable,
                maxAttempts,
                message: error instanceof Error ? error.message : String(error),
                item: {
                  documentId: meta?.documentId ?? m.documentId,
                  effectiveNamespace:
                    meta?.effectiveNamespace ?? ctx.momentGraphNamespace,
                  orderMs: orderMsByItemId.get(m.id) ?? null,
                },
              },
            }
          );

          let recovered = false;
          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (!retryable) {
              break;
            }
            const waitMs = computeBackoffMs(env, attempt);
            console.error("[moment-replay] item failed, will retry", {
              runId,
              itemId: m.id,
              attempt,
              waitMs,
              error: error instanceof Error ? error.message : String(error),
            });
            await addReplayRunEvent(
              { env, momentGraphNamespace: null },
              {
                runId,
                level: "warn",
                kind: "worker.item_retry",
                payload: { itemId: m.id, attempt, waitMs },
              }
            );
            await sleep(waitMs);
            try {
              const writeStart = Date.now();
              await addMoment(m, ctx, { embedding });
              const writeMs = Math.max(0, Date.now() - writeStart);
              itemIdToMomentId.set(m.id, m.id);
              const orderMs = orderMsByItemId.get(m.id) ?? null;
              await markReplayItemsDone(
                { env, momentGraphNamespace: null },
                { runId, itemIds: [m.id] }
              );
              await setReplayCursorWithTelemetry(
                { env, momentGraphNamespace: null },
                {
                  runId,
                  cursor: { lastOrderMs: orderMs, lastItemId: m.id },
                  replayedItemsDelta: 1,
                  lastItem: {
                    documentId: meta?.documentId ?? m.documentId,
                    effectiveNamespace:
                      meta?.effectiveNamespace ?? ctx.momentGraphNamespace,
                  },
                  perf: {
                    embeddingCallsDelta: perfEmbeddingCallsDelta,
                    embeddingTotalMsDelta: perfEmbeddingTotalMsDelta,
                    timelineFitCallsDelta: meta?.timelineFitCallsDelta ?? 0,
                    timelineFitTotalMsDelta: meta?.timelineFitTotalMsDelta ?? 0,
                    dbWritesDelta: 1,
                    dbWritesTotalMsDelta: writeMs,
                  },
                }
              );
              lastOrderMs = orderMs;
              lastItemId = m.id;
              recovered = true;
              break;
            } catch (retryErr) {
              await addReplayRunEvent(
                { env, momentGraphNamespace: null },
                {
                  runId,
                  level: "warn",
                  kind: "worker.item_retry_failed",
                  payload: {
                    itemId: m.id,
                    attempt,
                    message:
                      retryErr instanceof Error
                        ? retryErr.message
                        : String(retryErr),
                  },
                }
              );
              if (!isRetryableUpstreamError(retryErr)) {
                break;
              }
              if (attempt + 1 >= maxAttempts) {
                break;
              }
            }
          }

          if (recovered) {
            continue;
          }

          await markReplayItemFailedAndPauseRun(
            { env, momentGraphNamespace: null },
            {
              runId,
              itemId: m.id,
              errorPayload: {
                phase: "replay-item",
                retryable,
                message: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : null,
              },
              item: {
                documentId: meta?.documentId ?? m.documentId,
                effectiveNamespace:
                  meta?.effectiveNamespace ?? ctx.momentGraphNamespace,
                orderMs: orderMsByItemId.get(m.id) ?? null,
              },
            }
          );
          await addReplayRunEvent(
            { env, momentGraphNamespace: null },
            {
              runId,
              level: "error",
              kind: "worker.paused_on_item_error",
              payload: {
                itemId: m.id,
                retryable,
                maxAttempts,
                message: error instanceof Error ? error.message : String(error),
                item: {
                  documentId: meta?.documentId ?? m.documentId,
                  effectiveNamespace:
                    meta?.effectiveNamespace ?? ctx.momentGraphNamespace,
                  orderMs: orderMsByItemId.get(m.id) ?? null,
                },
              },
            }
          );
          return;
        }
      }
    }

    const batchDurationMs = Math.max(0, Date.now() - batchStartedAt);
    await addReplayRunEvent(
      { env, momentGraphNamespace: null },
      {
        runId,
        level: "info",
        kind: "worker.batch_done",
        payload: {
          fetchedItems: items.length,
          processedItems: momentsToAdd.length,
          durationMs: batchDurationMs,
          lastOrderMs,
          lastItemId,
        },
      }
    );

    console.log("[moment-replay] replay batch done", {
      runId,
      processedItems: momentsToAdd.length,
      lastOrderMs,
      lastItemId,
      batchDurationMs,
    });

    const batchDelayMs = envNumber(env, "MOMENT_REPLAY_BATCH_DELAY_MS") ?? 250;
    await sleep(batchDelayMs);

    if ((env as any).ENGINE_INDEXING_QUEUE) {
      await setReplayEnqueuedFlag(
        { env, momentGraphNamespace: null },
        { runId, replayEnqueued: true }
      );
      await addReplayRunEvent(
        { env, momentGraphNamespace: null },
        {
          runId,
          level: "info",
          kind: "worker.enqueued_next",
          payload: { afterDelayMs: batchDelayMs },
        }
      );
      await (env as any).ENGINE_INDEXING_QUEUE.send({
        jobType: "moment-replay-replay",
        momentReplayRunId: runId,
      });
    } else {
      await addReplayRunEvent(
        { env, momentGraphNamespace: null },
        {
          runId,
          level: "error",
          kind: "worker.missing_queue_binding",
          payload: {},
        }
      );
    }
  } catch (error) {
    await addReplayRunEvent(
      { env, momentGraphNamespace: null },
      {
        runId,
        level: "error",
        kind: "worker.unhandled_error",
        payload: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : null,
        },
      }
    );
    throw error;
  }
}
