export type MicroBatchIdentity = { batchHash: string; promptContextHash: string };

export async function computeMicroStreamHash(input: {
  batches: MicroBatchIdentity[];
  sha256Hex: (value: string) => Promise<string>;
}): Promise<string> {
  const identityParts = input.batches.map(
    (b) => `${b.batchHash}:${b.promptContextHash}`
  );
  return await input.sha256Hex(identityParts.join("\n"));
}

export function extractAnchorsFromStreams(input: {
  streams: any[];
  extractAnchorTokens: (text: string, maxTokens: number) => string[];
  maxTokensPerMoment: number;
  maxAnchors: number;
}): string[] {
  const anchors: string[] = [];
  for (const s of input.streams) {
    const moments = Array.isArray((s as any).macroMoments)
      ? ((s as any).macroMoments as any[])
      : [];
    for (const m of moments) {
      const text = `${m.title ?? ""}\n${m.summary ?? ""}`.trim();
      for (const tok of input.extractAnchorTokens(text, input.maxTokensPerMoment)) {
        anchors.push(tok);
        if (anchors.length >= input.maxAnchors) {
          return anchors;
        }
      }
    }
  }
  return anchors;
}

