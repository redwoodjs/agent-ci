import { computeDeterministicLinkingDecision } from "../../../../engine/core/linking/deterministicLinkingOrchestrator";
import { resolveThreadHeadForDocumentAsOf } from "../../../../engine/core/linking/explicitRefThreadHead";
import { PipelineContext } from "../../../../engine/runtime/types";
import { Moment } from "../../../../engine/types";

export async function runDeterministicLinkingForDocument(input: {
  r2Key: string;
  context: PipelineContext;
  moments: Moment[];
}): Promise<{
  decisions: Array<{
    childMomentId: string;
    proposedParentId: string | null;
    audit: any;
    streamId: string;
    macroIndex: number;
  }>;
}> {
  const { r2Key, context, moments } = input;
  const decisions: any[] = [];

  // Sort moments by stream and index to facilitate prevId lookup
  // Actually Phase 5 returns them in a sensible order, but let's be safe
  const momentByStreamAndIndex = new Map<string, Moment>();
  for (const m of moments) {
    const meta = m.sourceMetadata as any;
    const streamId = meta?.simulation?.streamId || "stream";
    const macroIndex = meta?.simulation?.macroIndex ?? 0;
    momentByStreamAndIndex.set(`${streamId}:${macroIndex}`, m);
  }

  for (const childMoment of moments) {
    const meta = childMoment.sourceMetadata as any;
    const streamId = meta?.simulation?.streamId || "stream";
    const macroIndex = meta?.simulation?.macroIndex ?? 0;

    const prevMomentId =
      macroIndex > 0
        ? momentByStreamAndIndex.get(`${streamId}:${macroIndex - 1}`)?.id ?? null
        : null;

    const decision = await computeDeterministicLinkingDecision({
      ports: {
        resolveThreadHeadForDocumentAsOf: async (args) => {
          return resolveThreadHeadForDocumentAsOf({
            ...args,
            context: {
              env: context.env,
              momentGraphNamespace: context.momentGraphNamespace || null,
            },
          });
        },
      },
      r2Key,
      streamId,
      macroIndex,
      childMomentId: childMoment.id,
      prevMomentId,
      childDocumentId: childMoment.documentId,
      childCreatedAt: childMoment.createdAt,
      childSourceMetadata: childMoment.sourceMetadata || {},
      macroAnchors: (childMoment as any).anchors || [], // anchors might have been added in classification
      childTextForFallbackAnchors: `${childMoment.title || ""}\n${
        childMoment.summary || ""
      }`,
    });

    decisions.push({
      childMomentId: childMoment.id,
      proposedParentId: decision.proposedParentId,
      audit: decision.audit,
      streamId,
      macroIndex,
    });
  }

  return { decisions };
}
