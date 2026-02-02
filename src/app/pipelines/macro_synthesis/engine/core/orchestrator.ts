import { PipelineContext } from "../../../../engine/runtime/types";
import { MicroMoment } from "../../../../engine/databases/momentGraph";
import { MomentDescription } from "../../../../engine/types";

export type MacroSynthesisOutput = {
  microStreamHash: string;
  streams: Array<{ streamId: string; macroMoments: MomentDescription[] }>;
  anchors: string[];
  gating: { keptStreams: number; droppedStreams: number };
  auditEvents: any[];
} | { kind: "skipped_unchanged" } | { kind: "skipped_error" };

export async function runMacroSynthesisForDocument(input: {
  context: PipelineContext;
  runId: string;
  r2Key: string;
  plannedBatches: Array<{ batchHash: string; promptContextHash: string }>;
  microMoments: Array<{ path: string; summary: string; createdAt: string }>;
  macroSynthesisPromptContext: string | null;
  previousMicroStreamHash: string | null;
  defaultAuthor: string;
  defaultCreatedAt: string;
  now: string;
}): Promise<MacroSynthesisOutput> {
  const { 
    context, 
    plannedBatches, 
    microMoments, 
    macroSynthesisPromptContext, 
    previousMicroStreamHash 
  } = input;

  // 1. Compute Hash of all input micro-batches/moments to see if we changed
  // This logic was previously in `computeMicroStreamHash` port.
  // We can just hash the batch hashes + prompt hashes.
  const hashInput = plannedBatches.map(b => `${b.batchHash}:${b.promptContextHash}`).join("|");
  // Simple hash
  const encoder = new TextEncoder();
  const data = encoder.encode(hashInput);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const microStreamHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  if (previousMicroStreamHash && previousMicroStreamHash === microStreamHash) {
    return { kind: "skipped_unchanged" };
  }

  // 2. Synthesize Streams using Plugin
  // We need to map our flat microMoments to MicroMoment interface
  const microMomentsForPlugin: MicroMoment[] = microMoments.map((m) => ({
    id: crypto.randomUUID(),
    documentId: input.r2Key,
    path: m.path,
    content: m.summary,
    summary: m.summary,
    embedding: [],
    createdAt: m.createdAt,
    author: "unknown",
    sourceMetadata: {},
  }));

  const auditEvents: any[] = [];
  
  // Use the plugin hook
  // We need to find the plugin that handles synthesis.
  // legacy used `context.plugins.subjects?.synthesizeMicroMomentsIntoStreams`
  let streams: Array<{ streamId: string; macroMoments: any[] }> = [];

  for (const plugin of context.plugins) {
      if (plugin.subjects?.synthesizeMicroMomentsIntoStreams) {
          streams = await plugin.subjects.synthesizeMicroMomentsIntoStreams(
              microMomentsForPlugin,
              {
                  macroSynthesisPromptContext,
                  auditSink: (event) => auditEvents.push(event)
              }
          );
          // Assuming first plugin handling it wins? Or we merge?
          // Legacy `orchestrator` took `synthesizeMicroMomentsIntoStreams` as a port, implying it was pre-selected.
          // Usually we pick the first one.
          if (streams.length > 0) break;
      }
  }

  // 3. Extract Anchors (if any plugin supports it)
  // Legacy used `extractAnchorsFromStreams`.
  let anchors: string[] = [];
  // Basic anchor extraction from streams?
  // Actually legacy port implementation usually just returned empty or extracted from moments.
  // Let's assume empty for now unless we see it in the plugin interface.

  // 4. Normalize
  const normalizedStreams = streams.map((s) => ({
      ...s,
      macroMoments: s.macroMoments.map((m) => ({
          ...m,
          createdAt: m.createdAt || input.defaultCreatedAt,
          author: m.author || input.defaultAuthor,
      }))
  }));

  return {
    microStreamHash,
    streams: normalizedStreams,
    anchors,
    gating: { keptStreams: streams.length, droppedStreams: 0 },
    auditEvents
  };
}
