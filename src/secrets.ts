import { env } from "cloudflare:workers";
import { z } from "zod";

const secretsSchema = z.object({
  // Environment Variables
  AI_GOOGLE_KEY: z.string().min(1),
  AI_CEREBRAS_KEY: z.string().min(1),
  AUTH_SECRET_KEY: z.string().min(1),
  API_KEY: z.string().min(1),
  INGEST_API_KEY: z.string().min(1),
  DISCORD_BOT_TOKEN: z.string().min(1).optional(),

  // Other variables
  SIMULATION_HEURISTIC_MODE: z.string().optional(),
  LLM_REASONING_EFFORT: z.string().optional(),
});

/**
 * Validates the environment variables using Zod.
 * Throws an error immediately if validation fails.
 * Returns the original 'env' object to preserve all bindings and types.
 */
function validateSecrets() {
  const result = secretsSchema.safeParse(env);

  if (!result.success) {
    const errorMsg = `❌ Invalid environment variables:\n${result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n")}`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  // We return the original env from cloudflare:workers to preserve bindings (AI, DB, etc.)
  // and their types defined in worker-configuration.d.ts
  return env;
}

/**
 * Validated environment variables and bindings.
 * Importing this will trigger validation and fail the worker if requirements aren't met.
 */
export const SECRETS = validateSecrets();
