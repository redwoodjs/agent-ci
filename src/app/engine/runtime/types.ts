import { type Database } from "rwsdk/db";
import type { momentMigrations } from "../databases/momentGraph/migrations";
import type { IndexingHookContext, VectorizeIndex, Chunk, Document, Plugin, Moment, MacroMomentDescription } from "../types";
export type { IndexingHookContext, VectorizeIndex, Chunk, Document, Plugin, Moment, MacroMomentDescription };
import type { LLMAlias, LLMOptions } from "../utils/llm";

export type MomentDatabase = Database<typeof momentMigrations>;

export interface LLMProvider {
  call(prompt: string, alias?: LLMAlias, options?: LLMOptions): Promise<string>;
}

export interface PipelineContext extends IndexingHookContext {
  db: MomentDatabase;
  vector: VectorizeIndex;
  llm: LLMProvider;
  env: Cloudflare.Env;
  plugins: Plugin[];
  storage: StorageStrategy;
}

export interface Phase<TInput = any, TOutput = any> {
  name: string;
  next?: string;
  execute(input: TInput, context: PipelineContext): Promise<TOutput>;
}

export type PhaseExecution<TInput, TOutput> = (
  input: TInput,
  context: PipelineContext
) => Promise<TOutput>;

export interface StorageStrategy {
  load<T>(phase: Phase, input: any): Promise<T | null>;
  save(phase: Phase, input: any, output: any): Promise<void>;
}

export interface TransitionStrategy {
  dispatchNext(nextPhase: string, output: any, input: any): Promise<void>;
}

export interface RuntimeStrategies {
  storage: StorageStrategy;
  transition: TransitionStrategy;
}
