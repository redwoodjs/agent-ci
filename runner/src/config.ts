import { z } from "zod";

const configSchema = z.object({
  BRIDGE_URL: z.string().url(),
  BRIDGE_API_KEY: z.string().min(1),
  GITHUB_USERNAME: z.string().min(1),
  GITHUB_REPO: z.string().min(1),
  GITHUB_API_URL: z.string().url().default("https://api.github.com"),
});

export type Config = z.infer<typeof configSchema>;

export const config = configSchema.parse(process.env);
