import {
  createEngineContext,
  type Chunk,
  type Document,
  type IndexingHookContext,
  type Plugin,
} from "../index";

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function uuidFromSha256Hex(hashHex: string): string {
  const hex = (hashHex ?? "").replace(/[^0-9a-f]/gi, "").toLowerCase();
  const padded = (hex + "0".repeat(64)).slice(0, 64);
  const bytes = padded.slice(0, 32);
  return `${bytes.slice(0, 8)}-${bytes.slice(8, 12)}-${bytes.slice(
    12,
    16
  )}-${bytes.slice(16, 20)}-${bytes.slice(20, 32)}`;
}

function truncateToChars(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars);
}

export function chunkChunksForMicroComputation(
  chunks: Chunk[],
  opts: { maxBatchChars: number; maxChunkChars: number; maxBatchItems: number }
): Chunk[][] {
  const maxBatchChars =
    Number.isFinite(opts.maxBatchChars) && opts.maxBatchChars > 0
      ? opts.maxBatchChars
      : 10_000;
  const maxChunkChars =
    Number.isFinite(opts.maxChunkChars) && opts.maxChunkChars > 0
      ? opts.maxChunkChars
      : 2_000;
  const maxBatchItems =
    Number.isFinite(opts.maxBatchItems) && opts.maxBatchItems > 0
      ? opts.maxBatchItems
      : 10;

  const out: Chunk[][] = [];
  let currentBatch: Chunk[] = [];
  let currentChars = 0;

  function flush() {
    if (currentBatch.length > 0) {
      out.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }
  }

  for (const chunk of chunks) {
    const content = truncateToChars(chunk.content ?? "", maxChunkChars);
    const projectedChars = currentChars + content.length;

    if (
      currentBatch.length > 0 &&
      (currentBatch.length >= maxBatchItems || projectedChars > maxBatchChars)
    ) {
      flush();
    }

    currentBatch.push({
      ...chunk,
      content,
    });
    currentChars += content.length;

    if (currentBatch.length >= maxBatchItems || currentChars > maxBatchChars) {
      flush();
    }
  }

  flush();
  return out;
}

async function runFirstMatchHook<T>(
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

  const document = await runFirstMatchHook(plugins, (plugin) =>
    plugin.prepareSourceDocument?.(indexingContext)
  );
  if (!document) {
    throw new Error("No plugin could prepare document");
  }
  return { document, indexingContext };
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

export function computeMicroItemsWithoutLlm(batchChunks: Chunk[]): string[] {
  const items = batchChunks
    .map((c) => (c.content ?? "").trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((c) => c.slice(0, 300));
  if (items.length > 0) {
    return items;
  }
  return ["(empty batch)"];
}

export function extractAnchorTokens(text: string, maxTokens: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  function add(token: string) {
    const t = token.trim();
    if (!t) {
      return;
    }
    if (seen.has(t)) {
      return;
    }
    seen.add(t);
    out.push(t);
  }

  const canon = text.match(/mchn:\/\/[a-z]+\/[^\s)\]]+/g) ?? [];
  for (const m of canon) {
    add(m);
    if (out.length >= maxTokens) {
      return out;
    }
  }

  const issueRefs = text.match(/#\d{2,6}/g) ?? [];
  for (const m of issueRefs) {
    add(m);
    if (out.length >= maxTokens) {
      return out;
    }
  }

  const backtick = text.match(/`([^`]{1,80})`/g) ?? [];
  for (const m of backtick) {
    const inner = m.slice(1, -1);
    add(inner);
    if (out.length >= maxTokens) {
      return out;
    }
  }

  return out;
}

export function getIndexingPlugins(env: Cloudflare.Env): Plugin[] {
  return createEngineContext(env, "indexing").plugins;
}

