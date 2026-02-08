
export type {
  Source,
  Document,
  Chunk,
  ChunkMetadata,
  Plugin,
  EngineContext,
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

import { callLLM } from "./utils/llm";
import { getMomentGraphDb } from "./simulation/db";
import {
  getMomentGraphNamespaceFromEnv,
} from "./momentGraphNamespace";
import type { LLMProvider } from "./runtime/types";

function getLLM(env: Cloudflare.Env): LLMProvider {
  return {
    call: (prompt, alias, options) => callLLM(prompt, alias, options),
  };
}

export function createEngineContext(
  env: Cloudflare.Env,
  mode: "indexing" | "querying"
): EngineContext {
  const namespace = getMomentGraphNamespaceFromEnv(env);
  
  // Base context with plugins
  const base: EngineContext = {
    plugins: [
      redwoodScopeRouterPlugin,
      githubPlugin,
      discordPlugin,
      cursorPlugin,
      defaultPlugin,
    ],
    env,
    // Initialize services that are safe to create immediately
    db: getMomentGraphDb(env, namespace),
    llm: getLLM(env),
    // vector: getVectorIndex(env), // Vector not available yet in this environment
  };

  // Proxy to protect against silent failures
  return new Proxy(base, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      
      // If accessing a service property that is undefined, throw a helpful error
      if (
        (prop === "llm" || prop === "vector" || prop === "db") &&
        value === undefined
      ) {
        throw new Error(
          `EngineContext Service Error: Attempted to access '${String(
            prop
          )}' but it was not initialized. ` +
            `Ensure this environment provides the necessary bindings and configurations.`
        );
      }
      
      return value;
    },
  });
}
