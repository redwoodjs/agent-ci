import type { Chunk, Document, IndexingHookContext, Plugin } from "../types";

export type IndexingDocumentPreparationPorts = {
  prepareSourceDocument: (input: { indexingContext: IndexingHookContext }) => Promise<Document>;
  computeMomentGraphNamespaceForIndexing: (input: {
    document: Document;
    indexingContext: IndexingHookContext;
    plugins: Plugin[];
  }) => Promise<string | null>;
  getMomentGraphNamespacePrefixFromEnv: (env: Cloudflare.Env) => string | null;
  applyMomentGraphNamespacePrefixValue: (
    baseNamespace: string,
    prefix: string | null
  ) => string;
  splitDocumentIntoChunks: (input: {
    document: Document;
    indexingContext: IndexingHookContext;
    plugins: Plugin[];
  }) => Promise<Chunk[]>;
  loadProcessedChunkHashes: (input: {
    r2Key: string;
    momentGraphNamespace: string | null;
  }) => Promise<string[]>;
};

export async function runIndexingDocumentPreparation(input: {
  ports: IndexingDocumentPreparationPorts;
  r2Key: string;
  env: Cloudflare.Env;
  plugins: Plugin[];
  overrideNamespace: string | null;
  overridePrefix: string | null;
  indexingMode: "indexing" | "replay";
  forceRecollect: boolean;
}): Promise<{
  document: Document;
  indexingContext: IndexingHookContext;
  effectiveNamespace: string | null;
  chunks: Chunk[];
  newChunks: Chunk[];
  oldChunkHashes: string[];
}> {
  const indexingContext: IndexingHookContext = {
    r2Key: input.r2Key,
    env: input.env,
    momentGraphNamespace: null,
    indexingMode: input.indexingMode,
  };

  const document = await input.ports.prepareSourceDocument({ indexingContext });

  const baseNamespace =
    typeof input.overrideNamespace === "string" && input.overrideNamespace.trim().length > 0
      ? input.overrideNamespace.trim()
      : await input.ports.computeMomentGraphNamespaceForIndexing({
          document,
          indexingContext,
          plugins: input.plugins,
        });

  const envPrefix = input.ports.getMomentGraphNamespacePrefixFromEnv(input.env);
  const prefix =
    typeof input.overridePrefix === "string" && input.overridePrefix.trim().length > 0
      ? input.overridePrefix.trim()
      : envPrefix;

  const effectiveNamespace = input.ports.applyMomentGraphNamespacePrefixValue(
    baseNamespace ?? "",
    prefix
  );

  indexingContext.momentGraphNamespace = effectiveNamespace;

  const chunks = await input.ports.splitDocumentIntoChunks({
    document,
    indexingContext,
    plugins: input.plugins,
  });

  const oldChunkHashes = await input.ports.loadProcessedChunkHashes({
    r2Key: input.r2Key,
    momentGraphNamespace: effectiveNamespace,
  });
  const oldSet = new Set(oldChunkHashes);

  const newChunks = input.forceRecollect
    ? chunks
    : chunks.filter((c) => !oldSet.has(c.contentHash ?? ""));

  return {
    document,
    indexingContext,
    effectiveNamespace,
    chunks,
    newChunks,
    oldChunkHashes,
  };
}

