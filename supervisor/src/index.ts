import { config } from "./config.js";

async function main() {
  console.log(`[Supervisor] Starting supervisor for repo: ${config.GITHUB_REPO}`);

  // Warm pool removed — the server (server/index.ts) is the entry point for runs.
  process.exit(0);
}

main().catch((err) => {
  console.error("[Supervisor] Fatal error:", err);
  process.exit(1);
});
