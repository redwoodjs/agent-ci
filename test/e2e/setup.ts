import { execa, type ResultPromise } from "execa";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../");

export class E2ETestHarness {
  private dtuProcess?: ResultPromise;
  private dtuPort = 8990;

  async startDTU() {
    console.log("[E2E] Starting DTU...");
    this.dtuProcess = execa("pnpm", ["tsx", "dtu-github-actions/src/server/index.ts"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        DTU_PORT: this.dtuPort.toString(),
        BRIDGE_URL: "http://localhost:8911",
        GITHUB_WEBHOOK_SECRET: "e2e-secret",
      },
      stdio: "inherit", // Useful for debugging
    });

    // Wait for DTU to be ready
    let attempts = 0;
    while (attempts < 10) {
      try {
        const res = await fetch(`http://localhost:${this.dtuPort}/`);
        if (res.ok) {
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
      attempts++;
    }
    if (attempts === 10) {
      throw new Error("DTU failed to start");
    }
    console.log("[E2E] DTU ready.");
  }

  async stopDTU() {
    if (this.dtuProcess) {
      this.dtuProcess?.kill();
      await this.dtuProcess.catch(() => {});
    }
  }

  async seedJob(job: any) {
    const res = await fetch(`http://localhost:${this.dtuPort}/_dtu/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(job),
    });
    if (!res.ok) {
      throw new Error(`Failed to seed job: ${res.status}`);
    }
    return await res.json();
  }

  async runSupervisor(jobId: string) {
    console.log(`[E2E] Running supervisor for job ${jobId}...`);
    const proc = execa(
      "pnpm",
      [
        "tsx",
        "supervisor/src/cli.ts",
        "run",
        "--workflow",
        ".github/workflows/tests.yml",
        "--task",
        "test",
      ],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          GITHUB_API_URL: `http://localhost:${this.dtuPort}`,
          GITHUB_REPO: "redwoodjs/opposite-actions",
          BRIDGE_URL: "http://localhost:8911",
          BRIDGE_API_KEY: "e2e-key",
          GITHUB_USERNAME: "e2e-user",
        },
      },
    );

    // Debug: Pipe output
    proc.stdout?.pipe(process.stdout);
    proc.stderr?.pipe(process.stderr);

    try {
      return await proc;
    } catch (e: any) {
      console.error(`[E2E] Supervisor failed: ${e.message}`);
      if (e.stdout) {
        console.error(`[E2E] Supervisor stdout: ${e.stdout}`);
      }
      if (e.stderr) {
        console.error(`[E2E] Supervisor stderr: ${e.stderr}`);
      }
      throw e;
    }
  }
}
