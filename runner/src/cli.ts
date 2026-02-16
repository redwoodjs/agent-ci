import { execSync } from "child_process";
import path from "path";
import { config } from "./config";

async function run() {
  const command = process.argv[2];
  const arg = process.argv[3];

  if (command === "run") {
    await handleRun(arg);
  } else {
    console.log("Usage: oa <command> [args]");
    console.log("Commands:");
    console.log("  run [sha]: Run local CI simulation (defaults to HEAD)");
    process.exit(1);
  }
}

async function handleRun(sha?: string) {
  console.log("[OA] Starting local CI simulation...");

  try {
    // 1. Get Repo Info
    const repoPath = process.cwd();
    const repoName = path.basename(repoPath);
    
    let headSha: string;
    if (sha) {
      try {
        headSha = execSync(`git rev-parse --verify ${sha}`).toString().trim();
        console.log(`[OA] Using provided SHA: ${headSha}`);
      } catch (e) {
        throw new Error(`Invalid SHA: ${sha}`);
      }
    } else {
      headSha = execSync("git rev-parse HEAD").toString().trim();
      console.log(`[OA] Using HEAD: ${headSha}`);
    }
    
    // We assume the username is in config
    const username = config.GITHUB_USERNAME;

    console.log(`[OA] Repo: ${repoName} (${repoPath})`);

    // 2. Queue Job via Bridge
    const bridgeUrl = config.BRIDGE_URL;
    const apiKey = config.BRIDGE_API_KEY;

    console.log(`[OA] Requesting job from Bridge: ${bridgeUrl}`);

    const response = await fetch(`${bridgeUrl}/api/local-job`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        username,
        repoName,
        repoPath,
        headSha,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Bridge failure: ${response.status} ${error}`);
    }

    const result = await response.json() as { status: string; deliveryId: string };
    console.log(`[OA] Success! Job queued. Delivery ID: ${result.deliveryId}`);
    console.log(`[OA] The runner will pick this up shortly.`);

  } catch (error: any) {
    console.error(`[OA] Failed to trigger run: ${error.message}`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("[OA] Fatal error:", err);
  process.exit(1);
});
