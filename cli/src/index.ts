import { config } from "./config.js";

async function main() {
  console.log(`[CLI] Starting CLI for repo: ${config.GITHUB_REPO}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[CLI] Fatal error:", err);
  process.exit(1);
});
