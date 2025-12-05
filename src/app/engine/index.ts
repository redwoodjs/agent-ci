export {
  indexDocument,
  query,
  getSubjectGraphForQuery,
  listAllSubjects,
} from "./engine";
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
  return {
    plugins: [githubPlugin, discordPlugin, cursorPlugin, defaultPlugin],
    env,
  };
}
