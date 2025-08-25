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

  await sandbox.exposePort(8910, {
    hostname: "localhost:5173",
  });

  for (const port of exposePorts) {
    await sandbox.exposePort(port, {
      hostname: "localhost:5173",
    });
  }

  await sandbox.writeFile(
    "/root/.claude/.credentials.json",
    JSON.stringify({
      claudeAiOauth: {
        accessToken: env.CLAUDE_CODE_ACCESS_TOKEN,
        refreshToken: env.CLAUDE_CODE_REFRESH_TOKEN,
        expiresAt: env.CLAUDE_CODE_EXPIRES_AT,
        scopes: ["user:inference", "user:profile"],
        subscriptionType: "pro",
      },
    })
  );

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

  scriptLines.push("cd /workspace");
  for (const command of runOnBoot) {
    scriptLines.push(`echo "Running: ${command}"`);
    scriptLines.push(command);
  }
  scriptLines.push(processCommand + " &");
  scriptLines.push(`npx wait-port ${exposePorts[0]}`);

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
  return await sandbox.startProcess("./bootstrap.sh");
}
