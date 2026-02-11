
import { z } from "zod";

const secretsSchema = z.object({
  GITHUB_WEBHOOK_SECRET: z.string().min(1, "GITHUB_WEBHOOK_SECRET is required"),
  GITHUB_APP_ID: z.string().min(1, "GITHUB_APP_ID is required"),
  GITHUB_PRIVATE_KEY: z.string().min(1, "GITHUB_PRIVATE_KEY is required"),
});

export type Secrets = z.infer<typeof secretsSchema>;

function parseEnvVars(): Secrets {
  const result = secretsSchema.safeParse(process.env);

  if (!result.success) {
    const missingVars = result.error.issues
      .map((issue) => issue.path.join("."))
      .join(", ");

    throw new Error(
      `Invalid configuration: The following environment variables are missing or invalid in process.env: ${missingVars}.\n` +
      `Please ensure they are set in your environment configuration (e.g. .dev.vars for local development or environment variables for deployment).`
    );
  }

  return result.data;
}

export const SECRETS = parseEnvVars();
