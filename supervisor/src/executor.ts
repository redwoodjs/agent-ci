import { Job } from "./types.js";
import { config } from "./config.js";
import Docker from "dockerode";
import fs from "fs";
import { createLogContext, finalizeLog } from "./logger.js";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const IMAGE = "ghcr.io/catthehacker/ubuntu:act-latest";

export async function ensureImageExists(): Promise<void> {
  console.log(`[Executor] Ensuring image ${IMAGE} exists...`);
  const images = await docker.listImages({
    filters: JSON.stringify({ reference: [IMAGE] }),
  });

  if (images.length === 0) {
    console.log(`[Executor] Pulling image ${IMAGE}...`);
    await new Promise<void>((resolve, reject) => {
      docker.pull(IMAGE, (err: any, stream: any) => {
        if (err) {
          return reject(err);
        }
        docker.modem.followProgress(stream, (err: any) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    });
    console.log(`[Executor] Pull complete.`);
  } else {
    console.log(`[Executor] Image ${IMAGE} already present.`);
  }
}

export async function executeJob(job: Job): Promise<void> {
  const { name: runnerName, outputLogPath } = createLogContext("executor");

  const _logStream = fs.createWriteStream(outputLogPath, { flags: "a" });

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
    fs.appendFileSync(outputLogPath, logBuffer.toString());

    // Finalize filename
    const commitSha = job.headSha || "unknown";
    const finalPath = finalizeLog(outputLogPath, exitCode, commitSha, runnerName);
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
    if (fs.existsSync(outputLogPath)) {
      const commitSha = job.headSha || "unknown";
      const finalPath = finalizeLog(outputLogPath, 1, commitSha, runnerName);
      console.log(`[Executor] Log finalized (failure): ${finalPath}`);
    }
    throw error;
  }
}
