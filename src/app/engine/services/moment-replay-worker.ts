import type {
  Document,
  IndexingHookContext,
  MacroMomentDescription,
  Moment,
} from "../types";
import { createEngineContext } from "../index";
import { addMoment } from "../momentDb";
import {
  fetchReplayItemsBatch,
  getReplayCursor,
  getReplayStreamState,
  markReplayItemsDone,
  setReplayCursor,
  setReplayRunStatus,
  setReplayStreamState,
} from "../db/momentReplay";
import { applyMomentGraphNamespacePrefixValue } from "../momentGraphNamespace";

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

  const baseNamespaceRaw = message.momentGraphNamespace;
  const baseNamespace =
    typeof baseNamespaceRaw === "string" && baseNamespaceRaw.trim().length > 0
      ? baseNamespaceRaw.trim()
      : null;
  const prefixRaw = message.momentGraphNamespacePrefix;
  const prefix =
    typeof prefixRaw === "string" && prefixRaw.trim().length > 0
      ? prefixRaw.trim()
      : null;
  const effectiveNamespace =
    baseNamespace && prefix
      ? applyMomentGraphNamespacePrefixValue(baseNamespace, prefix)
      : baseNamespace;

  await setReplayRunStatus(
    { env, momentGraphNamespace: effectiveNamespace },
    { runId, status: "replaying" }
  );

  const cursor = (await getReplayCursor(
    { env, momentGraphNamespace: effectiveNamespace },
    { runId }
  )) ?? { lastOrderMs: null, lastItemId: null };

  const items = await fetchReplayItemsBatch(
    { env, momentGraphNamespace: effectiveNamespace },
    { runId, cursor, limit: 120 }
  );

  if (items.length === 0) {
    await setReplayRunStatus(
      { env, momentGraphNamespace: effectiveNamespace },
      { runId, status: "completed" }
    );
    return;
  }

  const engineContext = createEngineContext(env, "indexing");
  const momentGraphContext = {
    env,
    momentGraphNamespace: effectiveNamespace,
  };

  let lastOrderMs: number | null = cursor.lastOrderMs;
  let lastItemId: string | null = cursor.lastItemId;

  const doneItemIds: string[] = [];

  for (const item of items) {
    const payload = item.payload ?? {};
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
      const prev = await getReplayStreamState(
        { env, momentGraphNamespace: effectiveNamespace },
        { runId, documentId, streamId }
      );
      parentId = prev ?? undefined;
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

    const momentId = crypto.randomUUID();
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

    await addMoment(moment, momentGraphContext);

    await setReplayStreamState(
      { env, momentGraphNamespace: effectiveNamespace },
      { runId, documentId, streamId, lastMomentId: momentId }
    );

    doneItemIds.push(item.itemId);
    lastOrderMs = item.orderMs;
    lastItemId = item.itemId;
  }

  await markReplayItemsDone(
    { env, momentGraphNamespace: effectiveNamespace },
    { runId, itemIds: doneItemIds }
  );

  await setReplayCursor(
    { env, momentGraphNamespace: effectiveNamespace },
    {
      runId,
      cursor: { lastOrderMs, lastItemId },
      replayedItemsDelta: doneItemIds.length,
    }
  );

  if ((env as any).ENGINE_INDEXING_QUEUE) {
    await (env as any).ENGINE_INDEXING_QUEUE.send({
      jobType: "moment-replay-replay",
      momentReplayRunId: runId,
      momentGraphNamespace: baseNamespace,
      momentGraphNamespacePrefix: prefix,
    });
  }
}
