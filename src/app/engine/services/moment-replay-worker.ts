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
  getReplayStreamState,
  markReplayItemsDone,
  setReplayCursor,
  setReplayRunStatus,
  setReplayStreamState,
} from "../db/momentReplay";

type ReplayMessage = {
  jobType?: unknown;
  momentReplayRunId?: unknown;
  momentGraphNamespace?: unknown;
  momentGraphNamespacePrefix?: unknown;
};

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
  if (documentId.startsWith("github/")) return "github";
  if (documentId.startsWith("discord/")) return "discord";
  if (documentId.startsWith("cursor/")) return "cursor";
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

  console.log("[moment-replay] replay start", { runId });

  await setReplayRunStatus(
    { env, momentGraphNamespace: null },
    { runId, status: "replaying" }
  );

  const cursor = (await getReplayCursor(
    { env, momentGraphNamespace: null },
    { runId }
  )) ?? { lastOrderMs: null, lastItemId: null };

  const items = await fetchReplayItemsBatch(
    { env, momentGraphNamespace: null },
    { runId, cursor, limit: 30 }
  );

  if (items.length === 0) {
    await setReplayRunStatus(
      { env, momentGraphNamespace: null },
      { runId, status: "completed" }
    );
    console.log("[moment-replay] replay complete", { runId });
    return;
  }

  const engineContext = createEngineContext(env, "indexing");

  let lastOrderMs: number | null = cursor.lastOrderMs;
  let lastItemId: string | null = cursor.lastItemId;

  const doneItemIds: string[] = [];
  const momentsToAdd: Moment[] = [];
  const momentContexts: Array<{
    env: Cloudflare.Env;
    momentGraphNamespace: string | null;
  }> = [];
  const itemIdToMomentId = new Map<string, string>();

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
      };

      for (const plugin of engineContext.plugins) {
        const propose = plugin.subjects?.proposeMacroMomentParent;
        if (!propose) {
          continue;
        }
        const attempt = await propose(
          document,
          macroMoment,
          0,
          indexingContext
        );
        if (attempt?.parentMomentId) {
          parentId = attempt.parentMomentId ?? undefined;
          break;
        }
      }
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
      ...(typeof importance === "number" ? { importance } : null),
      ...(sourceMetadata ? { sourceMetadata } : null),
    };

    momentsToAdd.push(moment);
    momentContexts.push(momentGraphContext);

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

    doneItemIds.push(item.itemId);
    lastOrderMs = item.orderMs;
    lastItemId = item.itemId;
  }

  if (momentsToAdd.length > 0) {
    let embeddings: number[][] = [];
    try {
      embeddings = await getEmbeddings(momentsToAdd.map((m) => m.summary));
    } catch (error) {
      console.error("[moment-replay] embedding batch failed", {
        runId,
        count: momentsToAdd.length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    for (let i = 0; i < momentsToAdd.length; i++) {
      const m = momentsToAdd[i]!;
      const ctx = momentContexts[i]!;
      const embedding = embeddings[i] ?? null;
      try {
        await addMoment(m, ctx, { embedding });
        itemIdToMomentId.set(m.id, m.id);
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
            const payload = (items.find((it) => it.itemId === m.id)?.payload ??
              {}) as any;
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
            continue;
          }
        }
        throw error;
      }
    }
  }

  await markReplayItemsDone(
    { env, momentGraphNamespace: null },
    { runId, itemIds: doneItemIds }
  );

  await setReplayCursor(
    { env, momentGraphNamespace: null },
    {
      runId,
      cursor: { lastOrderMs, lastItemId },
      replayedItemsDelta: doneItemIds.length,
    }
  );

  console.log("[moment-replay] replay batch done", {
    runId,
    processedItems: doneItemIds.length,
    lastOrderMs,
    lastItemId,
  });

  // Avoid hammering Workers AI with rapid successive batch retries.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  if ((env as any).ENGINE_INDEXING_QUEUE) {
    await (env as any).ENGINE_INDEXING_QUEUE.send({
      jobType: "moment-replay-replay",
      momentReplayRunId: runId,
    });
  }
}
