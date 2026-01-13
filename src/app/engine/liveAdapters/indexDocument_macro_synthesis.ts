import { computeMicroStreamHash, extractAnchorsFromStreams } from "../phaseCores/macro_synthesis_core";
import { extractAnchorTokens } from "../utils/anchorTokens";

export async function computeIndexDocumentMacroSynthesisIdentity(input: {
  plannedBatches: Array<{ batchHash: string; promptContextHash: string }>;
  streams: any[];
  hashStrings: (values: string[]) => Promise<string>;
}): Promise<{ microStreamHash: string; anchors: string[] }> {
  const microStreamHash = await computeMicroStreamHash({
    batches: input.plannedBatches,
    sha256Hex: async (value) => await input.hashStrings([value]),
  });

  const anchors = extractAnchorsFromStreams({
    streams: input.streams,
    extractAnchorTokens,
    maxTokensPerMoment: 8,
    maxAnchors: 60,
  });

  return { microStreamHash, anchors };
}

