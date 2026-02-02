import type { MomentDescription, Document } from "../../../../engine/types";
import { PipelineContext } from "../../../../engine/runtime/types";
import { synthesizeMicroMomentsIntoStreams } from "../../../../engine/synthesis/synthesizeMicroMoments";
import { 
  computeMicroStreamHash, 
  extractAnchorsFromStreams 
} from "../../../../engine/lib/phaseCores/macroSynthesisCore";
import { extractAnchorTokens } from "../../../../engine/utils/anchorTokens";

async function sha256Hex(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function computeMacroSynthesisForDocument(input: {
  document: Document;
  context: PipelineContext;
  plannedBatches: Array<{ batchHash: string; promptContextHash: string }>;
  microMoments: Array<{ path: string; summary: string; createdAt: string; author: string }>;
}): Promise<{
  microStreamHash: string;
  streams: Array<{ streamId: string; macroMoments: MomentDescription[] }>;
  anchors: string[];
  auditEvents: any[];
}> {
  const { document, context, plannedBatches, microMoments } = input;

  // 1. Compute Stream Hash (Idempotency)
  const microStreamHash = await computeMicroStreamHash({
    batches: plannedBatches,
    sha256Hex,
  });

  const auditEvents: any[] = [];

  // 2. Map to engine types
  const engineMicroMoments = microMoments.map((m) => ({
    id: crypto.randomUUID(),
    documentId: document.id,
    path: m.path,
    content: m.summary,
    summary: m.summary,
    embedding: [],
    createdAt: m.createdAt,
    author: m.author,
    sourceMetadata: {},
  }));

  // 3. Synthesize
  const macroSynthesisPromptContext = (document as any).metadata?.macroSynthesisPromptContext ?? null;
  const streams = await synthesizeMicroMomentsIntoStreams(
    engineMicroMoments,
    {
      macroSynthesisPromptContext,
      auditSink: (event) => auditEvents.push(event),
    }
  );

  // 4. Extract Anchors
  const anchors = extractAnchorsFromStreams({
    streams,
    extractAnchorTokens,
    maxTokensPerMoment: 30, // Standard
    maxAnchors: 20, // Standard
  });

  return {
    microStreamHash,
    streams: streams as any,
    anchors,
    auditEvents,
  };
}
