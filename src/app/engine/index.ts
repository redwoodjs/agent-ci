export { indexDocument, query } from "./engine";
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
  githubPlugin,
  discordPlugin,
  cursorPlugin,
  defaultPlugin,
} from "./plugins";

export function createEngineContext(
  env: Cloudflare.Env,
  mode: "indexing" | "querying"
): EngineContext {
  if (mode === "indexing") {
    return {
      plugins: [githubPlugin, discordPlugin, cursorPlugin],
      env,
    };
  }

  return {
    plugins: [githubPlugin, discordPlugin, cursorPlugin, defaultPlugin],
    env,
  };
}
