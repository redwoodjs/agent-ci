export { indexDocument, query } from "./runners/live";
export type {
  Source,
  Document,
  Chunk,
  ChunkMetadata,
  Plugin,
  EngineContext,
  IndexingHookContext,
  QueryHookContext,
} from "./types";
import type { EngineContext } from "./types";
import {
  redwoodScopeRouterPlugin,
  githubPlugin,
  discordPlugin,
  cursorPlugin,
  defaultPlugin,
} from "./plugins";

export function createEngineContext(
  env: Cloudflare.Env,
  mode: "indexing" | "querying"
): EngineContext {
  return {
    plugins: [
      redwoodScopeRouterPlugin,
      githubPlugin,
      discordPlugin,
      cursorPlugin,
      defaultPlugin,
    ],
    env,
  };
}
