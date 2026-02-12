import { config } from "./config";
import { startWarmPool, stopWarmPool } from "./warm-pool";

async function main() {
  console.log(`[Runner] Starting runner for user: ${config.GITHUB_USERNAME}`);
  console.log(`[Runner] Bridge URL: ${config.BRIDGE_URL}`);

  await startWarmPool();

  const cleanup = async () => {
    console.log("[Runner] Shutting down...");
    await stopWarmPool();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => {
  console.error("[Runner] Fatal error:", err);
  process.exit(1);
});
