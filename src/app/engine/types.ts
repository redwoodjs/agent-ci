export type Source =
  | "github"
  | "cursor"
  | "slack"
  | "meeting-notes"
  | "discord";

export interface Document {
  id: string;
  source: Source;
  type: string;
  content: string;
  metadata: {
    title: string;
    url: string;
    createdAt: string;
    author: string;
    sourceMetadata?: Record<string, any>;
    [key: string]: any;
  };
  subjectId?: string;
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
  source: string;
  type: string;
  documentTitle: string;
  author: string;
  jsonPath: string;
  sourceMetadata?: Record<string, any>;
  subjectId?: string;
  [key: string]: any;
}

export type PluginCompositionStrategy =
  | "waterfall"
  | "first-match"
  | "collector";

export interface Subject {
  id: string;
  title: string;
  documentIds: string[];
  parentId?: string;
  childIds?: string[];
  narrative?: string;
}

export interface SubjectSearchContext {
  text: string;
  env: Cloudflare.Env;
}

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
  evidence?: {
    splitDocumentIntoChunks?: (
      document: Document,
      context: IndexingHookContext
    ) => Promise<Chunk[]>;
    enrichChunk?: (
      chunk: Chunk,
      context: IndexingHookContext
    ) => Promise<Chunk>;
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
    reconstructContext?: (
      documentChunks: ChunkMetadata[],
      sourceDocument: any,
      context: QueryHookContext
    ) => Promise<ReconstructedContext | null>;
    optimizeContext?: (
      contexts: ReconstructedContext[],
      query: string,
      context: QueryHookContext
    ) => Promise<ReconstructedContext[]>;
    composeLlmPrompt?: (
      contexts: ReconstructedContext[],
      query: string,
      context: QueryHookContext
    ) => Promise<string>;
    formatFinalResponse?: (
      response: string,
      chunks: ChunkMetadata[],
      context: QueryHookContext
    ) => Promise<string>;
  };
  subjects?: {
    findSubjectForText?: (
      context: SubjectSearchContext
    ) => Promise<string | null>;
  };
}

export interface ReconstructedContext {
  content: string;
  source: string;
  primaryMetadata: ChunkMetadata;
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
