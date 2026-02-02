import type {
  Chunk,
  Document,
  IndexingHookContext,
  Plugin,
} from "../types";

export async function runFirstMatchHook<T>(
  plugins: Plugin[],
  fn: (plugin: Plugin) => Promise<T | null | undefined> | undefined
): Promise<T | null> {
  for (const plugin of plugins) {
    const result = await fn(plugin);
    if (result !== null && result !== undefined) {
      return result;
    }
  }
  return null;
}

export async function prepareDocumentForR2Key(
  r2Key: string,
  env: Cloudflare.Env,
  plugins: Plugin[]
): Promise<{ document: Document; indexingContext: IndexingHookContext }> {
  const indexingContext: IndexingHookContext = {
    r2Key,
    env,
    momentGraphNamespace: null,
    indexingMode: "indexing",
  };

  let lastError: any;
  for (let i = 0; i < 3; i++) {
    try {
      const document = await runFirstMatchHook(plugins, (plugin) =>
        plugin.prepareSourceDocument?.(indexingContext)
      );
      if (document) {
        return { document, indexingContext };
      }
    } catch (e) {
      lastError = e;
      if (i < 2) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
      }
    }
  }

  throw lastError || new Error("No plugin could prepare document");
}

export async function splitDocumentIntoChunks(
  document: Document,
  indexingContext: IndexingHookContext,
  plugins: Plugin[]
): Promise<Chunk[]> {
  const chunks = await runFirstMatchHook(plugins, (plugin) =>
    plugin.splitDocumentIntoChunks?.(document, indexingContext)
  );
  if (!chunks || chunks.length === 0) {
    throw new Error("No plugin could split document into chunks");
  }
  return chunks;
}

export async function getMicroPromptContext(
  document: Document,
  chunks: Chunk[],
  indexingContext: IndexingHookContext,
  plugins: Plugin[]
): Promise<string> {
  const microPromptContext = await runFirstMatchHook(plugins, (plugin) =>
    plugin.subjects?.getMicroMomentBatchPromptContext?.(
      document,
      chunks,
      indexingContext
    )
  );

  return (
    microPromptContext ??
    `Context: These chunks are from a single document.\n` +
      `Focus on concrete details and avoid generic summaries.\n`
  );
}

export async function computeMomentGraphNamespaceForIndexing(
  document: Document,
  indexingContext: IndexingHookContext,
  plugins: Plugin[]
): Promise<string | null> {
  const namespace = await runFirstMatchHook(plugins, async (plugin) =>
    plugin.scoping?.computeMomentGraphNamespaceForIndexing?.(
      document,
      indexingContext
    )
  );
  return namespace ?? null;
}
