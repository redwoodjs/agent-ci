import { config, loadOaConfig } from "./config.js";
import { setWorkingDirectory } from "./logger.js";
import { startWarmPool, stopWarmPool } from "./warm-pool.js";

async function main() {
  const args = process.argv.slice(2);
  let configPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && args[i + 1]) {
      configPath = args[i + 1];
      i++;
    }
  }

  const parsedConfig = loadOaConfig(configPath);
  if (parsedConfig.workingDirectory) {
    setWorkingDirectory(parsedConfig.workingDirectory);
  }

  console.log(`[Supervisor] Starting supervisor for user: ${config.GITHUB_USERNAME}`);
  console.log(`[Supervisor] Bridge URL: ${config.BRIDGE_URL}`);

  await startWarmPool();

  const cleanup = async () => {
    console.log("[Supervisor] Shutting down...");
    await stopWarmPool();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => {
  console.error("[Supervisor] Fatal error:", err);
  process.exit(1);
});
