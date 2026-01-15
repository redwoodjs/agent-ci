import type { MomentDescription } from "../../../types";

export type MacroSynthesisOrchestratorPorts = {
  computeMicroStreamHash: (input: {
    batches: Array<{ batchHash: string; promptContextHash: string }>;
  }) => Promise<string>;
  synthesizeMicroMomentsIntoStreams: (
    microMoments: Array<{ path: string; summary: string; createdAt: string }>,
    options?: {
      macroSynthesisPromptContext?: string | null;
      auditSink?: (event: any) => void;
    }
  ) => Promise<Array<{ streamId: string; macroMoments: any[] }>>;
  extractAnchorsFromStreams: (input: { streams: any[] }) => string[];
};

export async function computeMacroSynthesisForDocument(input: {
  ports: MacroSynthesisOrchestratorPorts;
  plannedBatches: Array<{ batchHash: string; promptContextHash: string }>;
  microStreamHash?: string | null;
  microMoments: Array<{ path: string; summary: string; createdAt: string }>;
  macroSynthesisPromptContext: string | null;
  now: string;
  documentId: string;
}): Promise<{
  microStreamHash: string;
  streams: Array<{ streamId: string; macroMoments: MomentDescription[] }>;
  anchors: string[];
  gating: { keptStreams: number; droppedStreams: number };
  auditEvents: any[];
}> {
  const microStreamHash =
    typeof input.microStreamHash === "string" &&
    input.microStreamHash.length > 0
      ? input.microStreamHash
      : await input.ports.computeMicroStreamHash({
          batches: input.plannedBatches,
        });

  const auditEvents: any[] = [];

  const streams = await input.ports.synthesizeMicroMomentsIntoStreams(
    input.microMoments,
    {
      macroSynthesisPromptContext: input.macroSynthesisPromptContext,
      auditSink: (event) => {
        auditEvents.push(event);
      },
    }
  );

  const anchors = input.ports.extractAnchorsFromStreams({ streams });

  const gating = {
    keptStreams: streams.length,
    droppedStreams: 0,
  };

  return {
    microStreamHash,
    streams: streams as any,
    anchors,
    gating,
    auditEvents,
  };
}
