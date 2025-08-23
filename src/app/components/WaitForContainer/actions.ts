"use server";

import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { getProjectInfo } from "@/app/services/project";

export async function bootstrapContainer(containerId: string) {
  const { repository, runOnBoot } = await getProjectInfo(containerId);

  const sandbox = getSandbox(env.Sandbox, containerId);
  await sandbox.start({
    enableInternet: true,
  });

  // Generate bootstrap script
  const scriptLines = ["#!/bin/bash", "set -e", ""];

  // Setup workspace
  if (repository) {
    scriptLines.push(`echo "Checking out repository: ${repository}"`);
    // Git checkout will be handled by sandbox.gitCheckout
  } else {
    scriptLines.push(
      'echo "Setting up minimal workspace"',
      "cd /",
      "mkdir -p /workspace",
      "cp -R /redwoodsdk/minimal/* /workspace"
    );
  }

  // Add boot commands
  scriptLines.push("cd /workspace");
  for (const command of runOnBoot) {
    scriptLines.push(`echo "Running: ${command}"`);
    scriptLines.push(command);
  }
  scriptLines.push("cd /machinen");
  scriptLines.push("echo $$ > bootstrap.pid");
  scriptLines.push("pnpm dev");
  const scriptContent = scriptLines.join("\n");

  // Write and execute the script
  await sandbox.writeFile("/machinen/bootstrap.sh", scriptContent);

  // Handle repository checkout if needed
  if (repository) {
    const result = await sandbox.gitCheckout(repository, {
      targetDir: "/workspace",
    });
    if (result.exitCode !== 0) {
      throw new Error(`Git checkout failed: ${result.stderr}`);
    }
  }

  await sandbox.exec("cd /machinen");
  await sandbox.exec("chmod +x bootstrap.sh");
  const result = await sandbox.startProcess("./bootstrap.sh");

  return { success: true, processId: result.id };
}

export async function startLongRunningProcess(containerId: string) {
  const { processCommand } = await getProjectInfo(containerId);
  const sandbox = getSandbox(env.Sandbox, containerId);
  await sandbox.exec("cd /workspace");
  const result = await sandbox.startProcess(processCommand);

  return { success: true, processId: result.id };
}

export async function exposePorts(containerId: string) {
  const { exposePorts } = await getProjectInfo(containerId);

  const sandbox = getSandbox(env.Sandbox, containerId);

  await sandbox.exposePort(8910, {
    hostname: "localhost:5173", // todo figure out how to get the port here? is it possible to get this from vite?
  });

  for (const port of exposePorts) {
    await sandbox.exposePort(port, {
      hostname: "localhost:5173", // todo figure out how to get the port here? is it possible to get this from vite?
    });
  }
}
