import { parse } from "jsonc-parser";
import { z } from "zod";
import fs from "fs";
import path from "path";
import os from "os";

const configSchema = z.object({
  BRIDGE_URL: z.string().url(),
  BRIDGE_API_KEY: z.string().min(1),
  GITHUB_USERNAME: z.string().min(1),
  GITHUB_REPO: z.string().min(1),
  GITHUB_API_URL: z.string().url().default("https://api.github.com"),
  EXIT_ON_ERROR: z
    .string()
    .default("false")
    .transform((val) => val === "true"),
});

export type Config = z.infer<typeof configSchema>;

export const config = configSchema.parse(process.env);

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "oa", "config.jsonc");

export function parseJsonc(fileContent: string): any {
  const errors: any[] = [];
  const result = parse(fileContent, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(`Failed to parse JSONC config with ${errors.length} error(s)`);
  }
  return result;
}

export function loadOaConfig(configPath?: string): { workingDirectory?: string } {
  const resolvedPath = configPath ? path.resolve(configPath) : DEFAULT_CONFIG_PATH;
  if (!fs.existsSync(resolvedPath)) {
    return {};
  }
  const content = fs.readFileSync(resolvedPath, "utf-8");
  return parseJsonc(content);
}
