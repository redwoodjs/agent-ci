export type Source = "github" | "cursor" | "slack" | "meeting-notes";

export interface Document {
  id: string;
  source: Source;
  type: string;
  content: string;
  metadata: {
    title?: string;
    url?: string;
    createdAt: string;
    author?: string;
    [key: string]: unknown;
  };
}

export interface Chunk {
  id: string;
  documentId: string;
  source: Source;
  content: string;
  metadata: ChunkMetadata;
}

export interface ChunkMetadata {
  chunkId: string;
  documentId: string;
  source: Source;
  type: string;
  documentTitle?: string;
  author?: string;
  jsonPath: string;
  [key: string]: unknown;
}

export type PluginCompositionStrategy =
  | "waterfall"
  | "first-match"
  | "collector";

export interface IndexingHookContext {
  r2Key: string;
  env: Cloudflare.Env;
}

export interface QueryHookContext {
  query: string;
  env: Cloudflare.Env;
}

export interface Plugin {
  name: string;
  prepareSourceDocument?: (
    context: IndexingHookContext
  ) => Promise<Document | null>;
  splitDocumentIntoChunks?: (
    document: Document,
    context: IndexingHookContext
  ) => Promise<Chunk[]>;
  enrichChunk?: (chunk: Chunk, context: IndexingHookContext) => Promise<Chunk>;
  prepareSearchQuery?: (
    query: string,
    context: QueryHookContext
  ) => Promise<string>;
  buildVectorSearchFilter?: (
    context: QueryHookContext
  ) => Promise<Record<string, unknown> | null>;
  rerankSearchResults?: (
    results: ChunkMetadata[],
    context: QueryHookContext
  ) => Promise<ChunkMetadata[]>;
  composeLlmPrompt?: (
    chunks: ChunkMetadata[],
    query: string,
    context: QueryHookContext
  ) => Promise<string>;
  formatFinalResponse?: (
    response: string,
    chunks: ChunkMetadata[],
    context: QueryHookContext
  ) => Promise<string>;
}

export interface EngineContext {
  plugins: Plugin[];
  env: Cloudflare.Env;
}

export interface VectorizeIndex {
  query(
    vector: number[],
    options?: {
      topK?: number;
      returnMetadata?: boolean;
      filter?: Record<string, unknown>;
    }
  ): Promise<{
    matches: Array<{
      id: string;
      score: number;
      metadata: ChunkMetadata;
    }>;
  }>;
  insert(
    vectors: Array<{ id: string; values: number[]; metadata: ChunkMetadata }>
  ): Promise<void>;
}
