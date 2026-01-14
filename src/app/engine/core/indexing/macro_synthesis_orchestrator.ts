import type { MomentDescription } from "../../types";

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
  useLlm: boolean;
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
    typeof input.microStreamHash === "string" && input.microStreamHash.length > 0
      ? input.microStreamHash
      : await input.ports.computeMicroStreamHash({
          batches: input.plannedBatches,
        });

  const auditEvents: any[] = [];

  let streams: Array<{ streamId: string; macroMoments: any[] }> = [];
  if (input.useLlm) {
    streams = await input.ports.synthesizeMicroMomentsIntoStreams(
      input.microMoments,
      {
        macroSynthesisPromptContext: input.macroSynthesisPromptContext,
        auditSink: (event) => {
          auditEvents.push(event);
        },
      }
    );
  } else {
    const summaries = input.microMoments
      .map((m) => m.summary)
      .filter(Boolean)
      .slice(0, 24);
    const groups: string[][] = [];
    for (let i = 0; i < summaries.length; i += 8) {
      groups.push(summaries.slice(i, i + 8));
    }
    const fallbackGroups = groups.length > 0 ? groups : [["(empty)"]];
    while (fallbackGroups.length < 3) {
      fallbackGroups.push(["(empty)"]);
    }
    const macroMoments = fallbackGroups.slice(0, 3).map((g, idx) => ({
      title: `Synthesis for ${input.documentId} (${idx + 1})`,
      summary: g.join(" ") || "(empty)",
      microPaths: input.microMoments
        .slice(idx * 16, idx * 16 + 50)
        .map((m) => m.path),
      importance: 0.5,
      createdAt: new Date(Date.parse(input.now) + idx * 60_000).toISOString(),
    }));
    streams = [
      {
        streamId: "stream-1",
        macroMoments,
      },
    ];
  }

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

