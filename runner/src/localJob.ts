import Docker from "dockerode";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { config } from "./config.js";
import { Job } from "./types.js";
// import { getTimestamp, ensureLogDirs, DEBUG_LOGS_DIR, finalizeLog, IN_PROGRESS_LOGS_DIR, COMPLETED_LOGS_DIR } from "./logger.js";
import { minimatch } from "minimatch";

const dockerHost = process.env.DOCKER_HOST || "unix:///var/run/docker.sock";
const dockerConfig = dockerHost.startsWith("unix://")
  ? { socketPath: dockerHost.replace("unix://", "") }
  : { host: dockerHost, protocol: "ssh" as const };

const docker = new Docker(dockerConfig);

const IMAGE = "ghcr.io/actions/actions-runner:latest";

function getFormattedTimestamp(): string {
  const now = new Date();
  const YYYY = now.getFullYear();
  const MM = String(now.getMonth() + 1).padStart(2, "0");
  const DD = String(now.getDate()).padStart(2, "0");
  const HH = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${YYYY}${MM}${DD}${HH}${mm}`;
}

function getNextRunnerId(): string {
  const logsBaseDir = path.resolve(process.cwd(), "_", "logs");
  if (!fs.existsSync(logsBaseDir)) return "1";

  const items = fs.readdirSync(logsBaseDir, { withFileTypes: true });
  const dirCount = items.filter(item => item.isDirectory() && item.name.startsWith("oa-runner-")).length;
  
  return String(dirCount + 1);
}

export async function executeLocalJob(job: Job): Promise<void> {
  const debugPattern = process.env.DEBUG || "";
  const isDebug = minimatch("runner", debugPattern) || minimatch("runner:*", debugPattern);

  console.log(`[LocalJob] DEBUG: config.GITHUB_API_URL = '${config.GITHUB_API_URL}'`);


  console.log(`[OA] ----------------------------------------------------------------`);
  console.log(`[OA] Job: ${job.githubRepo} (${(job.headSha || "HEAD").substring(0, 7)})`);
  console.log(`[OA] Delivery: ${job.deliveryId}`);
  console.log(`[OA] ----------------------------------------------------------------`);
  if (job.steps) {
      console.log(`[OA] Steps:`);
      job.steps.forEach((step: any) => {
          console.log(`[OA]   - ${step.Name} (${step.Id})`);
      });
  }
  console.log(`[OA] ----------------------------------------------------------------`);

  console.log(`[LocalJob] Starting local execution for job: ${job.deliveryId}`);

  // 1. Seed the job to Local DTU
  // This allows the runner to fetch the job details when it connects.
  try {
    const dtuUrl = config.GITHUB_API_URL;
    console.log(`[LocalJob] Seeding job to DTU at ${dtuUrl}...`);
    const response = await fetch(`${dtuUrl}/_dtu/seed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            id: job.githubJobId || "1",
            name: "local-job",
            status: "queued",
            ...job
        }),
    });
    if (!response.ok) {
        throw new Error(`Failed to seed DTU: ${response.status} ${response.statusText}`);
    }
    console.log(`[LocalJob] DTU seeded successfully.`);
  } catch (e: any) {
    console.error(`[LocalJob] Error seeding DTU: ${e.message}`);
    throw e;
  }

  // 2. Registration Token
  // Since we are running completely locally against the DTU, we don't need to 
  // fetch a real registration token from the Bridge/GitHub. The DTU mock 
  // server accepts any token for registration.
  const registrationToken = "mock_local_token"; 
  console.log(`[LocalJob] Using mock registration token for local execution.`);

  // 3. Prepare Runner Container
  const timestamp = getFormattedTimestamp();
  const runnerId = getNextRunnerId();
  const containerName = `oa-runner-${timestamp}-${runnerId}`;
  
  const logDir = path.resolve(process.cwd(), "_", "logs", containerName);
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  const workDir = path.resolve(process.cwd(), "_/work", containerName);
  const shimsDir = path.resolve(process.cwd(), "_/shims", containerName);

  if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
  if (!fs.existsSync(shimsDir)) fs.mkdirSync(shimsDir, { recursive: true });

  // Create git shim to protect local files
  const gitShimPath = path.join(shimsDir, "git");
  fs.writeFileSync(gitShimPath, `#!/bin/bash
case "$1" in
  checkout|fetch|reset|init)
    echo "[OA Shim] Intercepted '$1' to protect local files."
    exit 0
    ;;
  *)
    /usr/bin/git "$@"
    ;;
esac
`, { mode: 0o755 });

  // 4. Start Container
  console.log(`[LocalJob] Ensuring image ${IMAGE} exists...`);
  // (Assuming image exists or pulled elsewhere, but we should ensure it)
  // For brevity, skipping explicit pull check if we assume dev environment has it. 
  // But let's add a quick check if simple. 
  // Actually, let's trust Docker to pull if missing or fail. Code becomes cleaner.

  const dockerApiUrl = config.GITHUB_API_URL.replace("localhost", "host.docker.internal").replace("127.0.0.1", "host.docker.internal");
  console.log(`[LocalJob] DEBUG: dockerApiUrl = '${dockerApiUrl}'`);
  const repoUrl = `${dockerApiUrl}/${config.GITHUB_REPO}`;


  // 4. Prepare Clean Workspace (Checkout Emulation)
  const workspaceId = Date.now();
  const workspaceDir = path.resolve(process.cwd(), "_/work", `workspace-${workspaceId}`);
  if (!fs.existsSync(workspaceDir)) fs.mkdirSync(workspaceDir, { recursive: true });

  console.log(`[LocalJob] Preparing clean workspace in ${workspaceDir}...`);
  try {
    if (job.headSha && job.headSha !== "HEAD") {
      console.log(`[LocalJob] Exporting SHA ${job.headSha}...`);
      execSync(`git archive ${job.headSha} | tar -x -C ${workspaceDir}`, { stdio: "inherit" });
    } else {
      console.log(`[LocalJob] Exporting tracked files from working directory...`);
      // Note: checkout-index needs the trailing slash in --prefix
      execSync(`git checkout-index -a -f --prefix=${workspaceDir}/`, { stdio: "inherit" });
    }
  } catch (e: any) {
    console.error(`[LocalJob] Failed to prepare workspace: ${e.message}`);
    // Cleanup and abort
    if (fs.existsSync(workspaceDir)) fs.rmSync(workspaceDir, { recursive: true, force: true });
    throw e;
  }

  console.log(`[LocalJob] Spawning container ${containerName}...`);
  const container = await docker.createContainer({
    Image: IMAGE,
    name: containerName,
    Env: [
        `RUNNER_NAME=${containerName}`,
        `RUNNER_TOKEN=${registrationToken}`,
        `RUNNER_REPOSITORY_URL=${repoUrl}`,
        `GITHUB_API_URL=${dockerApiUrl}`,
        `GITHUB_SERVER_URL=${repoUrl}`,
        `GITHUB_REPOSITORY=${config.GITHUB_REPO}`,
        `OA_LOCAL_SYNC=true`,
        `OA_HEAD_SHA=${job.headSha || "HEAD"}`,
        `PATH=/tmp/oa-shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    ],
    Cmd: ["bash", "-c", "HOST_IP=$(getent hosts host.docker.internal | awk '{ print $1 }') && export DEBIAN_FRONTEND=noninteractive && sudo -n apt-get update >/dev/null 2>&1 && sudo -n apt-get install -y nginx >/dev/null 2>&1 && echo \"server { listen 80 default_server; location / { proxy_pass http://$HOST_IP:8910; proxy_set_header Host 127.0.0.1:80; } }\" | sudo tee /etc/nginx/sites-available/default > /dev/null && sudo ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default && (sudo service nginx start >/dev/null 2>&1 || sudo nginx >/dev/null 2>&1) && RESOLVED_URL=\"http://127.0.0.1:80/$GITHUB_REPOSITORY\" && export GITHUB_API_URL=\"http://127.0.0.1:80\" && export GITHUB_SERVER_URL=\"$RESOLVED_URL\" && ./config.sh --url $RESOLVED_URL --token $RUNNER_TOKEN --name $RUNNER_NAME --unattended --ephemeral --work _work --labels opposite-actions || echo \"Config warning: Service generation failed, proceeding...\" && ./run.sh --once"],
















    HostConfig: {
        Binds: [
            `${workDir}:/home/runner/_work`,
            "/var/run/docker.sock:/var/run/docker.sock",
            `${shimsDir}:/tmp/oa-shims`,
            `${logDir}:/home/runner/_diag`,
            // Mount the clean workspace as the repository root
            `${workspaceDir}:/home/runner/_work/${config.GITHUB_REPO}`
        ],
        AutoRemove: false // Keep it for inspection
    },
    Tty: true
  });

  await container.start();
  
    // 5. Stream Logs
    const logStream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true
    }) as NodeJS.ReadableStream;

    const logFileStream = fs.createWriteStream(path.join(logDir, "output.log"));
    logStream.pipe(process.stdout);
    logStream.pipe(logFileStream);

    // 6. Wait for Exit
    const waitResult = await container.wait();
    const exitCode = waitResult.StatusCode;

    console.log(`[LocalJob] Runner exited with code ${exitCode}`);

    // Allow a moment for any pending logs to flush
    await new Promise(r => setTimeout(r, 1000));

    console.log(`[LocalJob] Cleaning up...`);

    if (fs.existsSync(workspaceDir)) fs.rmSync(workspaceDir, { recursive: true, force: true });
    if (fs.existsSync(shimsDir)) fs.rmSync(shimsDir, { recursive: true, force: true });
    // We keep workDir (the runner settings/home) for now, or could clean it too.
}
