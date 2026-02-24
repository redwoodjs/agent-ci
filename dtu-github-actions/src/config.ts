import { z } from "zod";

import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const configSchema = z.object({
  /**
   * The URL of the OA-1 Bridge (Orchestrator).
   * Webhooks are sent here.
   */
  BRIDGE_URL: z.string().url(),

  /**
   * The secret used to sign GitHub webhooks.
   * Shared between the Simulation script and the Bridge.
   */
  GITHUB_WEBHOOK_SECRET: z.string().min(1),

  /**
   * The internal URL where the DTU Mock Server is reachable.
   * Simulation scripts seed this server.
   */
  DTU_URL: z.string().url().default("http://localhost:8910"),

  /**
   * The port the DTU Mock Server listens on.
   */
  DTU_PORT: z.coerce.number().default(8910),

  /**
   * Directory where cache archives should be stored.
   */
  DTU_CACHE_DIR: z.string().default(() => path.join(os.tmpdir(), "dtu_cache")),
});

export type Config = z.infer<typeof configSchema>;

export const config = configSchema.parse({
  BRIDGE_URL: process.env.BRIDGE_URL,
  GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
  DTU_URL: process.env.DTU_URL,
  DTU_PORT: process.env.DTU_PORT,
  DTU_CACHE_DIR: process.env.DTU_CACHE_DIR,
});

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "oa", "config.jsonc");

export function parseJsonc(fileContent: string): any {
  // Strip block comments
  let stripped = fileContent.replace(/\/\*[\s\S]*?\*\//g, "");
  // Strip line comments
  stripped = stripped.replace(/\/\/.*/g, "");
  try {
    return JSON.parse(stripped);
  } catch (e) {
    throw new Error(`Failed to parse JSONC config: ${(e as Error).message}`);
  }
}

export function loadOaConfig(configPath?: string): { workingDirectory?: string } {
  const resolvedPath = configPath ? path.resolve(configPath) : DEFAULT_CONFIG_PATH;
  if (!fs.existsSync(resolvedPath)) {
    return {};
  }
  const content = fs.readFileSync(resolvedPath, "utf-8");
  return parseJsonc(content);
}
