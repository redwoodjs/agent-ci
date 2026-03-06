import { execa } from "execa";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "../../");

/**
 * Run the supervisor CLI in headless mode against a workflow file.
 * No DTU setup needed — the supervisor spawns its own ephemeral DTU internally.
 */
export async function runSupervisor(workflow: string, task: string) {
  const proc = execa(
    "pnpm",
    ["tsx", "supervisor/src/cli.ts", "run", "--workflow", workflow, "--task", task],
    {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        GITHUB_REPO: "redwoodjs/machinen",
        BRIDGE_URL: "http://localhost:8911",
        BRIDGE_API_KEY: "e2e-key",
        GITHUB_USERNAME: "e2e-user",
        GITHUB_WEBHOOK_SECRET: "e2e-secret",
      },
    },
  );

  proc.stdout?.pipe(process.stdout);
  proc.stderr?.pipe(process.stderr);

  try {
    return await proc;
  } catch (e: any) {
    console.error(`[E2E] Supervisor failed: ${e.message}`);
    if (e.stdout) {
      console.error(`[E2E] stdout: ${e.stdout}`);
    }
    if (e.stderr) {
      console.error(`[E2E] stderr: ${e.stderr}`);
    }
    throw e;
  }
}
