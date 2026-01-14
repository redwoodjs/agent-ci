export async function computeMaterializedMomentIdentityTagged(input: {
  tag: string;
  identityScope: string;
  effectiveNamespace: string | null;
  documentId: string;
  streamId: string;
  macroIndex: number;
  sha256Hex: (value: string) => Promise<string>;
  uuidFromSha256Hex: (hex: string) => string;
}): Promise<{ momentId: string; rawIdHex: string }> {
  const rawIdHex = await input.sha256Hex(
    [
      input.tag,
      input.identityScope,
      input.effectiveNamespace ?? "",
      input.documentId,
      input.streamId,
      String(input.macroIndex),
    ].join("\n")
  );
  return { rawIdHex, momentId: input.uuidFromSha256Hex(rawIdHex) };
}

export async function computeMaterializedMomentIdentity(input: {
  runId: string;
  effectiveNamespace: string | null;
  documentId: string;
  streamId: string;
  macroIndex: number;
  sha256Hex: (value: string) => Promise<string>;
  uuidFromSha256Hex: (hex: string) => string;
}): Promise<{ momentId: string; rawIdHex: string }> {
  return await computeMaterializedMomentIdentityTagged({
    tag: "simulation-materialize-moment",
    identityScope: input.runId,
    effectiveNamespace: input.effectiveNamespace,
    documentId: input.documentId,
    streamId: input.streamId,
    macroIndex: input.macroIndex,
    sha256Hex: input.sha256Hex,
    uuidFromSha256Hex: input.uuidFromSha256Hex,
  });
}

export async function computeMicroPathsHash(input: {
  microPaths: string[] | null;
  sha256Hex: (value: string) => Promise<string>;
}): Promise<string | null> {
  const microPaths = Array.isArray(input.microPaths)
    ? input.microPaths.filter((p) => typeof p === "string")
    : null;
  if (!microPaths || microPaths.length === 0) {
    return null;
  }
  return await input.sha256Hex(microPaths.join("\n"));
}

