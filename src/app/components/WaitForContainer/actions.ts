"use server";

import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { getProjectInfo } from "@/app/services/project";

export async function bootstrapContainer(containerId: string) {
  const { repository, runOnBoot, exposePorts, processCommand } =
    await getProjectInfo(containerId);

  const sandbox = getSandbox(env.Sandbox, containerId);
  await sandbox.start({
    enableInternet: true,
  });

  // Helpers
  async function getExistingBootstrapProcess() {
    const processes = await sandbox.listProcesses();
    return processes.find((p: any) => p.command === "./bootstrap.sh");
  }

  async function tryAcquireBootstrapLock() {
    // Create an empty dir as a lock; mkdir is atomic
    const result = await sandbox.exec("mkdir /machinen/.bootstrap.lock");
    return result.exitCode === 0;
  }

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Fast-path: if process is already running, return it
  const existing = await getExistingBootstrapProcess();
  if (existing) {
    return existing;
  }

  // Attempt to acquire lock; if not available, backoff and wait for the other starter
  const lockAcquired = await tryAcquireBootstrapLock();
  if (!lockAcquired) {
    // Exponential backoff waiting for the other request to start the process
    let attempt = 0;
    const maxAttempts = 6; // ~ up to ~1.6s total (50,100,200,400,800,1000)
    let found: any | undefined;
    while (attempt < maxAttempts) {
      found = await getExistingBootstrapProcess();
      if (found) {
        return found;
      }
      const delay = Math.min(50 * Math.pow(2, attempt), 1000);
      await sleep(delay);
      attempt++;
    }
    // Try to acquire the lock again as a last resort
    if (!(await tryAcquireBootstrapLock())) {
      // If still cannot acquire, surface a clear error
      throw new Error(
        "Bootstrap is already in progress and process not yet visible. Please retry."
      );
    }
  }

  // We own the lock here
  try {
    // Only expose ports once we hold the lock to avoid duplicate operations
    await sandbox.exposePort(8910, {
      hostname: "localhost:5173",
    });

    await sandbox.exposePort(4096, {
      hostname: "localhost:5173",
    });

    for (const port of exposePorts) {
      await sandbox.exposePort(port, {
        hostname: "localhost:5173",
      });
    }

    // Generate bootstrap script
    const scriptLines = ["#!/bin/bash", "set -e", ""];

    // Setup workspace
    if (!repository) {
      scriptLines.push(
        'echo "Setting up minimal workspace"',
        "cd /",
        "mkdir -p /workspace",
        "cp -R /redwoodsdk/minimal/* /workspace"
      );
    }

    scriptLines.push("cd /machinen");
    scriptLines.push("pnpm dev --name=machinen &");
    scriptLines.push("npx wait-port 8910");
    scriptLines.push("opencode serve --port 4096 &");
    scriptLines.push("npx wait-port 4096");

    scriptLines.push("cd /workspace");
    for (const command of runOnBoot) {
      scriptLines.push(`echo \"Running: ${command}\"`);
      scriptLines.push(command);
    }
    scriptLines.push(processCommand + " &");
    // scriptLines.push(`npx wait-port ${exposePorts[0]}`);
    // Handle repository checkout if needed
    if (repository) {
      const result = await sandbox.gitCheckout(repository, {
        targetDir: "/workspace",
      });
      if (result.exitCode !== 0) {
        throw new Error(`Git checkout failed: ${result.stderr}`);
      }
    }

    await sandbox.writeFile("/machinen/bootstrap.sh", scriptLines.join("\n"));
    await sandbox.exec("cd /machinen");
    await sandbox.exec("chmod +x bootstrap.sh");

    // Double-check no other process slipped in between (shouldn't happen with lock)
    const prior = await getExistingBootstrapProcess();
    if (prior) {
      return prior;
    }

    return await sandbox.startProcess("./bootstrap.sh");
  } finally {
    // Release the lock
    await sandbox.exec("rmdir /machinen/.bootstrap.lock");
  }
}
