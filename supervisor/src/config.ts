import { z } from "zod";
import fs from "fs";
import path from "path";
import { PROJECT_ROOT } from "./working-directory.js";
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

/**
 * Load machine-local secrets from `.env.machine` at the machinen project root.
 * The file uses KEY=VALUE syntax (lines starting with # are ignored).
 * Returns an empty object if the file doesn't exist.
 */
export function loadMachineSecrets(baseDir?: string): Record<string, string> {
  const envMachinePath = path.join(baseDir ?? PROJECT_ROOT, ".env.machinen");
  if (!fs.existsSync(envMachinePath)) {
    return {};
  }
  const secrets: Record<string, string> = {};
  const lines = fs.readFileSync(envMachinePath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) {
      continue;
    }
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip optional surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      secrets[key] = value;
    }
  }
  return secrets;
}
