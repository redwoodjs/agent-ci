import { execa } from "execa";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "../../");

/**
 * Run the CLI in headless mode against a workflow file.
 * No DTU setup needed — the CLI spawns its own ephemeral DTU internally.
 */
export async function runCLI(workflow: string) {
  const proc = execa("pnpm", ["tsx", "cli/src/cli.ts", "run", "--workflow", workflow], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      GITHUB_REPO: "redwoodjs/agent-ci",
    },
  });

  proc.stdout?.pipe(process.stdout);
  proc.stderr?.pipe(process.stderr);

  try {
    return await proc;
  } catch (e: any) {
    console.error(`[E2E] CLI failed: ${e.message}`);
    if (e.stdout) {
      console.error(`[E2E] stdout: ${e.stdout}`);
    }
    if (e.stderr) {
      console.error(`[E2E] stderr: ${e.stderr}`);
    }
    throw e;
  }
}
