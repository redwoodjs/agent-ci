import type { MomentDescription } from "../../../../engine/types";
import type { MicroMoment } from "../../../../engine/databases/momentGraph";

export type MacroSynthesisOrchestratorPorts = {
  computeMicroStreamHash: (input: {
    batches: Array<{ batchHash: string; promptContextHash: string }>;
  }) => Promise<string>;
  synthesizeMicroMomentsIntoStreams: (
    microMoments: MicroMoment[],
    options?: {
      macroSynthesisPromptContext?: string | null;
      auditSink?: (event: any) => void;
    },
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

  const microMoments: MicroMoment[] = input.microMoments.map((m) => ({
    id: crypto.randomUUID(),
    documentId: input.documentId,
    path: m.path,
    content: m.summary,
    summary: m.summary,
    embedding: [],
    createdAt: m.createdAt,
    author: "unknown",
    sourceMetadata: {},
  }));

  const streams = await input.ports.synthesizeMicroMomentsIntoStreams(
    microMoments,
    {
      macroSynthesisPromptContext: input.macroSynthesisPromptContext,
      auditSink: (event) => {
        auditEvents.push(event);
      },
    },
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

export type MacroSynthesisDocumentPorts = {
  loadDocState: (input: {
    runId: string;
    r2Key: string;
  }) => Promise<{ hadError: boolean; changed: boolean }>;
  loadMicroBatches: (input: { runId: string; r2Key: string }) => Promise<
    Array<{
      batchHash: string;
      promptContextHash: string;
    }>
  >;
  loadPreviousMicroStreamHash: (input: {
    runId: string;
    r2Key: string;
  }) => Promise<string | null>;
  loadMicroMomentsForDocument: (input: {
    documentId: string;
    effectiveNamespace: string | null;
  }) => Promise<Array<{ path: string; summary: string; createdAt: string }>>;
  loadMicroBatchCacheItems: (input: {
    batchHash: string;
    promptContextHash: string;
  }) => Promise<string[]>;
  getMacroSynthesisInputs: (input: { r2Key: string }) => Promise<{
    documentId: string;
    defaultAuthor: string;
    defaultCreatedAt: string;
    macroSynthesisPromptContext: string | null;
  }>;
  persistMacroOutputs: (input: {
    runId: string;
    r2Key: string;
    microStreamHash: string;
    streams: any[];
    auditEvents: any[];
    gating: any;
    anchors: any;
    now: string;
  }) => Promise<void>;
} & MacroSynthesisOrchestratorPorts;

export async function runMacroSynthesisForR2Key(input: {
  ports: MacroSynthesisDocumentPorts;
  runId: string;
  r2Key: string;
  effectiveNamespace: string | null;
  now: string;
}): Promise<
  | { kind: "skipped_unchanged" }
  | { kind: "skipped_error" }
  | { kind: "reused" }
  | {
      kind: "computed";
      streamsProduced: number;
      macroMomentsProduced: number;
      streams: any[];
    }
> {
  const state = await input.ports.loadDocState({
    runId: input.runId,
    r2Key: input.r2Key,
  });

  if (state.hadError) {
    return { kind: "skipped_error" };
  }

  const plannedBatches = await input.ports.loadMicroBatches({
    runId: input.runId,
    r2Key: input.r2Key,
  });

  const microStreamHash = await input.ports.computeMicroStreamHash({
    batches: plannedBatches,
  });

  const prevHash = await input.ports.loadPreviousMicroStreamHash({
    runId: input.runId,
    r2Key: input.r2Key,
  });
  if (prevHash && prevHash === microStreamHash) {
    return { kind: "reused" };
  }

  const inputs = await input.ports.getMacroSynthesisInputs({
    r2Key: input.r2Key,
  });

  const existingMicroMoments = await input.ports.loadMicroMomentsForDocument({
    documentId: input.r2Key,
    effectiveNamespace: input.effectiveNamespace,
  });

  const microItems: Array<{
    path: string;
    summary: string;
    createdAt: string;
  }> = [];
  for (const b of plannedBatches) {
    const prefixPath = `chunk-batch:${b.batchHash}:`;
    const fromMomentGraph = existingMicroMoments
      .filter(
        (m) => typeof m?.path === "string" && m.path.startsWith(prefixPath),
      )
      .map((m) => ({
        path: String(m.path),
        summary: String(m.summary ?? "").trim(),
        createdAt: String(m.createdAt ?? input.now),
      }))
      .filter((m) => m.summary.length > 0);

    if (fromMomentGraph.length > 0) {
      microItems.push(...fromMomentGraph);
      continue;
    }

    const cached = await input.ports.loadMicroBatchCacheItems({
      batchHash: b.batchHash,
      promptContextHash: b.promptContextHash,
    });
    const asStrings = Array.isArray(cached)
      ? cached
          .filter((x) => typeof x === "string")
          .map((x) => (x as string).trim())
          .filter(Boolean)
      : [];

    for (let j = 0; j < asStrings.length; j++) {
      microItems.push({
        path: `${prefixPath}${j + 1}`,
        summary: asStrings[j]!,
        createdAt: input.now,
      });
    }
  }

  const synthesis = await computeMacroSynthesisForDocument({
    ports: input.ports,
    plannedBatches,
    microStreamHash,
    microMoments: microItems,
    macroSynthesisPromptContext: inputs.macroSynthesisPromptContext ?? null,
    now: input.now,
    documentId: inputs.documentId,
  });

  const normalizedStreams = synthesis.streams.map((s) => {
    const macroMoments = Array.isArray((s as any)?.macroMoments)
      ? ((s as any).macroMoments as any[])
      : [];
    const normalizedMacroMoments = macroMoments.map((m) => ({
      ...m,
      createdAt:
        typeof m?.createdAt === "string" && m.createdAt.trim().length > 0
          ? m.createdAt.trim()
          : inputs.defaultCreatedAt,
      author:
        typeof m?.author === "string" && m.author.trim().length > 0
          ? m.author.trim()
          : inputs.defaultAuthor,
    }));
    return { ...s, macroMoments: normalizedMacroMoments };
  });

  let macroMomentsProduced = 0;
  for (const s of normalizedStreams) {
    const mm = Array.isArray((s as any).macroMoments)
      ? ((s as any).macroMoments as any[])
      : [];
    macroMomentsProduced += mm.length;
  }

  await input.ports.persistMacroOutputs({
    runId: input.runId,
    r2Key: input.r2Key,
    microStreamHash: synthesis.microStreamHash,
    streams: normalizedStreams,
    auditEvents: synthesis.auditEvents,
    gating: synthesis.gating,
    anchors: synthesis.anchors,
    now: input.now,
  });

  return {
    kind: "computed",
    streamsProduced: normalizedStreams.length,
    macroMomentsProduced,
    streams: normalizedStreams,
  };
}
