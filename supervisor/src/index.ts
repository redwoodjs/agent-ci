import { config, loadOaConfig } from "./config.js";
import { setWorkingDirectory } from "./logger.js";

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

  // Warm pool removed — the server (server/index.ts) is the entry point for runs.
  process.exit(0);
}

main().catch((err) => {
  console.error("[Supervisor] Fatal error:", err);
  process.exit(1);
});
