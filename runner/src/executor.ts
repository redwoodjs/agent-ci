import { Job } from "./types.js";
import { config } from "./config.js";
import Docker from "dockerode";
import { spawn, execSync } from "child_process";
import path from "path";
import fs from "fs";
import { fetchRegistrationToken } from "./bridge.js";
import { getTimestamp, ensureLogDirs, finalizeLog, IN_PROGRESS_LOGS_DIR } from "./logger.js";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const IMAGE = "ghcr.io/catthehacker/ubuntu:act-latest";

function findRunnerPath(): string | null {
  const searchPaths = [
    path.join(process.cwd(), "actions-runner"), // actions-runner subfolder
    path.join(process.cwd(), "..", "actions-runner"), // actions-runner in project root
  ];

  for (const searchPath of searchPaths) {
    const runScript = path.join(searchPath, "run.sh");
    if (fs.existsSync(runScript)) {
      return searchPath;
    }
  }

  return null;
}

export async function startGitHubRunner(): Promise<void> {
  const runnerPath = findRunnerPath();

  if (!runnerPath) {
    console.log(
      "[GitHubRunner] Official runner (run.sh) not found in standard locations. Skipping official runner start.",
    );
    console.log(
      "[GitHubRunner] Tip: Install the official runner in the project root with the label 'opposite-actions'.",
    );
    return;
  }

  // 1. Check/Update Configuration
  const runnerConfigFile = path.join(runnerPath, ".runner");
  const expectedRepoUrl = `${config.GITHUB_API_URL}/${config.GITHUB_REPO}`;
  let needsConfig = true;

  if (fs.existsSync(runnerConfigFile)) {
    try {
      const currentConfig = JSON.parse(fs.readFileSync(runnerConfigFile, "utf-8"));
      if (currentConfig.gitHubUrl === expectedRepoUrl) {
        needsConfig = false;
        console.log(`[GitHubRunner] Existing configuration matches ${expectedRepoUrl}.`);
      } else {
        console.log(
          `[GitHubRunner] Configuration mismatch. Current: ${currentConfig.gitHubUrl}, Expected: ${expectedRepoUrl}`,
        );
      }
    } catch {
      console.warn("[GitHubRunner] Failed to read .runner config. Re-configuring...");
    }
  }

  if (needsConfig) {
    console.log(`[GitHubRunner] Configuring runner for: ${expectedRepoUrl}...`);
    try {
      const registrationToken = await fetchRegistrationToken();
      const configScript = path.join(runnerPath, "config.sh");

      execSync(
        `${configScript} --url ${expectedRepoUrl} --token ${registrationToken} --name local-runner --replace --unattended --labels opposite-actions`,
        {
          cwd: runnerPath,
          stdio: "inherit",
          env: {
            ...process.env,
            GITHUB_API_URL: config.GITHUB_API_URL,
            GITHUB_SERVER_URL: `${config.GITHUB_API_URL}/${config.GITHUB_REPO}`,
          },
        },
      );
      console.log("[GitHubRunner] Configuration successful.");
    } catch (error: any) {
      console.error("[GitHubRunner] Configuration failed:", error.message);
      // We'll try to start anyway, but it will likely fail if config is missing.
    }
  }

  // 2. Start Runner
  const runScript = path.join(runnerPath, "run.sh");
  console.log(`[GitHubRunner] Starting official runner from: ${runScript}`);

  const runnerProcess = spawn(runScript, [], {
    cwd: runnerPath,
    stdio: "inherit",
    env: {
      ...process.env,
      GITHUB_API_URL: config.GITHUB_API_URL,
      GITHUB_SERVER_URL: `${config.GITHUB_API_URL}/${config.GITHUB_REPO}`,
    },
  });

  runnerProcess.on("close", (code) => {
    console.log(`[GitHubRunner] Process exited with code ${code}`);
  });

  runnerProcess.on("error", (err) => {
    console.error(`[GitHubRunner] Failed to start process:`, err);
  });
}

export async function ensureImageExists(): Promise<void> {
  console.log(`[Executor] Ensuring image ${IMAGE} exists...`);
  const images = await docker.listImages({
    filters: JSON.stringify({ reference: [IMAGE] }),
  });

  if (images.length === 0) {
    console.log(`[Executor] Pulling image ${IMAGE}...`);
    await new Promise<void>((resolve, reject) => {
      docker.pull(IMAGE, (err: any, stream: any) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
    console.log(`[Executor] Pull complete.`);
  } else {
    console.log(`[Executor] Image ${IMAGE} already present.`);
  }
}

export async function executeJob(job: Job): Promise<void> {
  const timestamp = getTimestamp();
  const runnerName = `executor-${job.deliveryId.substring(0, 8)}`;
  ensureLogDirs();
  let logPath = path.join(IN_PROGRESS_LOGS_DIR, `${timestamp}-${runnerName}.log`);

  const _logStream = fs.createWriteStream(logPath, { flags: "a" });

  console.log(`[Executor] Processing job: ${job.deliveryId}`);

  try {
    // 1. Ensure image exists
    await ensureImageExists();

    // 2. Prepare Environment for Direct GitHub Pull
    const envVars = [
      `GITHUB_JOB_ID=${job.githubJobId}`,
      `GITHUB_REPO=${job.githubRepo}`,
      `GITHUB_TOKEN=${job.githubToken}`,
      `GITHUB_API_URL=${config.GITHUB_API_URL}`,
    ];

    // 3. Create and Start Container
    console.log(`[Executor] Creating container...`);
    const container = await docker.createContainer({
      Image: IMAGE,
      Cmd: [
        "/bin/sh",
        "-c",
        `echo "[Worker] Fetching job details from GitHub..." && \\
         curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \\
         "$GITHUB_API_URL/repos/$GITHUB_REPO/actions/jobs/$GITHUB_JOB_ID" | tee /tmp/job_details.json && \\
         echo "\n[Worker] GitHub job details retrieved successfully."`,
      ],
      Env: envVars,
      Tty: false,
    });

    console.log(`[Executor] Container created: ${container.id}`);
    await container.start();
    console.log(`[Executor] Container started.`);

    // 4. Wait for completion
    const waitResult = await container.wait();
    const exitCode = waitResult.StatusCode;
    console.log(`[Executor] Container exited with code: ${exitCode}`);

    // 5. Get Logs
    const logBuffer = await container.logs({
      stdout: true,
      stderr: true,
      follow: false,
    });

    // Write everything to the log file
    fs.appendFileSync(logPath, logBuffer.toString());

    // Finalize filename
    const commitSha = job.headSha || "unknown";
    const finalPath = finalizeLog(logPath, exitCode, commitSha);
    console.log(`[Executor] Log finalized: ${finalPath}`);

    // 6. Cleanup
    if (exitCode !== 0) {
      console.warn(
        `[Executor] Job failed with exit code ${exitCode}. Container ${container.id} preserved for debugging.`,
      );
    } else {
      await container.remove({ v: true, force: true });
      console.log(`[Executor] Container removed.`);
    }
  } catch (error: any) {
    console.error(`[Executor] Job failed:`, error.message);
    if (fs.existsSync(logPath)) {
      const commitSha = job.headSha || "unknown";
      const finalPath = finalizeLog(logPath, 1, commitSha);
      console.log(`[Executor] Log finalized (failure): ${finalPath}`);
    }
    throw error;
  }
}
