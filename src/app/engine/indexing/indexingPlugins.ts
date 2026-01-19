import type { Plugin } from "../types";
import { createEngineContext } from "../index";

export function getIndexingPlugins(env: Cloudflare.Env): Plugin[] {
  return createEngineContext(env, "indexing").plugins;
}

