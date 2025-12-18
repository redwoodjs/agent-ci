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
  contentHash?: string;
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

export interface Moment {
  id: string;
  documentId: string;
  summary: string;
  title: string;
  parentId?: string;
  microPaths?: string[];
  microPathsHash?: string;
  importance?: number;
  createdAt: string;
  author: string;
  sourceMetadata?: Record<string, any>;
}

export interface MomentDescription {
  title: string;
  content: string;
  author: string;
  createdAt: string;
  sourceMetadata?: Record<string, any>;
}

export interface MacroMomentDescription extends MomentDescription {
  summary: string;
  microPaths: string[];
  importance?: number;
}

export interface MicroMomentDescription {
  path: string;
  content: string;
  author: string;
  createdAt: string;
  sourceMetadata?: Record<string, any>;
}

export interface IndexingHookContext {
  r2Key: string;
  env: Cloudflare.Env;
  momentGraphNamespace?: string | null;
}

export interface QueryHookContext {
  query: string;
  env: Cloudflare.Env;
  clientContext?: Record<string, any>;
  momentGraphNamespace?: string | null;
}

export interface MacroMomentParentProposal {
  parentMomentId: string;
  matchedSubjectId: string;
  score: number;
}

export interface Plugin {
  name: string;
  scoping?: {
    computeMomentGraphNamespaceForIndexing?: (
      document: Document,
      context: IndexingHookContext
    ) => Promise<string | null> | string | null;
    computeMomentGraphNamespaceForQuery?: (
      context: QueryHookContext
    ) => Promise<string | null> | string | null;
  };
  prepareSourceDocument?: (
    context: IndexingHookContext
  ) => Promise<Document | null>;
  splitDocumentIntoChunks?: (
    document: Document,
    context: IndexingHookContext
  ) => Promise<Chunk[]>;
  evidence?: {
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
    computeMicroMomentsForChunkBatch?: (
      chunks: Chunk[],
      context: IndexingHookContext
    ) => Promise<string[] | null>;
    getMicroMomentBatchPromptContext?: (
      document: Document,
      chunks: Chunk[],
      context: IndexingHookContext
    ) => Promise<string | null>;
    getMacroSynthesisPromptContext?: (
      document: Document,
      context: IndexingHookContext
    ) => Promise<string | null>;
    proposeMacroMomentParent?: (
      document: Document,
      macroMoment: MacroMomentDescription,
      macroMomentIndex: number,
      context: IndexingHookContext
    ) => Promise<MacroMomentParentProposal | null>;
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

export interface CursorConversationLatestJson {
  id: string;
  user_email?: string;
  workspace_roots?: string[];
  generations: {
    id: string;
    events: any[];
  }[];
}
