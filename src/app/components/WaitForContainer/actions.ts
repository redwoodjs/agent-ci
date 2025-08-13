"use server";

import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { getProjectInfo } from "@/app/services/project";

export async function isContainerReady(containerId: string) {
  let bootstrap = false;
  let longRunningProcess = false;
  let portsExposed = false;

  const project = await getProjectInfo(containerId);

  const sandbox = getSandbox(env.Sandbox, containerId);
  try {
    const pid = await sandbox.readFile("/tmp/bootstrap.pid");
    bootstrap = true;
  } catch {
    bootstrap = false;
  }

  const processes = await sandbox.listProcesses();
  if (processes.findIndex((p) => p.command === project.processCommand) !== -1) {
    longRunningProcess = true;
  }

  // There should be a better way to check if the container is ready?
  // What do I mean by ready exactly?
  // There are different kinds of ready based on the software
  // that is running on it.
  // const sandbox = getSandbox(env.Sandbox, containerId);
  const ports = await sandbox.getExposedPorts("localhost");
  for (const p of ports) {
    if (project.exposePorts.includes(p.port)) {
      portsExposed = true;
    }
  }

  return {
    bootstrap,
    longRunningProcess,
    portsExposed,
    ready: bootstrap && longRunningProcess && portsExposed,
  };
}

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
      "echo 'Setting up minimal workspace'",
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
  // This is a hack to check if the bootstrap process has run.
  // We should have a better way to do this.
  // Can we grab the process id from the bash script?

  scriptLines.push("echo $$ > /tmp/bootstrap.pid");
  scriptLines.push("echo '[machinen-bootstrap-complete]'");

  const scriptContent = scriptLines.join("\n");

  // Write and execute the script
  await sandbox.writeFile("/tmp/bootstrap.sh", scriptContent);

  // Handle repository checkout if needed
  if (repository) {
    const result = await sandbox.gitCheckout(repository, {
      targetDir: "/workspace",
    });
    if (result.exitCode !== 0) {
      throw new Error(`Git checkout failed: ${result.stderr}`);
    }
  }

  // Execute bootstrap script
  const result = await sandbox.startProcess("bash /tmp/bootstrap.sh", {
    cwd: "/",
  });

  return { success: true, processId: result.id };
}

export async function startLongRunningProcess(containerId: string) {
  const { processCommand } = await getProjectInfo(containerId);

  const sandbox = getSandbox(env.Sandbox, containerId);
  const result = await sandbox.startProcess(processCommand, {
    cwd: "/workspace",
  });
  return { success: true, processId: result.id };
}

export async function exposePorts(containerId: string) {
  const { exposePorts } = await getProjectInfo(containerId);

  const sandbox = getSandbox(env.Sandbox, containerId);
  for (const port of exposePorts) {
    await sandbox.exposePort(port, {
      hostname: "localhost:5173", // todo figure out how to get the port here? is it possible to get this from vite?
    });
  }
}
