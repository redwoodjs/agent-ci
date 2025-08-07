"use server";

import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";

export async function isContainerReady(containerId: string) {
  const sandbox = getSandbox(env.SANDBOX, containerId);
  const p = await sandbox.getExposedPorts("localhost");
  return p.length > 0;
}

export async function startContainer(containerId: string) {
  // how do we make this only run once?
  const sandbox = getSandbox(env.SANDBOX, containerId);
  await sandbox.start({
    enableInternet: true,
    envVars: {
      GITHUB_TOKEN: env.GITHUB_TOKEN,
    },
  });
  await sandbox.exposePort(8910, { hostname: "localhost" });
  const r = await sandbox.gitCheckout(
    "https://github.com/redwoodjs/kitchensink.git",
    {
      targetDir: "/workspace",
    }
  );

  await sandbox.startProcess("pnpm install", {
    cwd: "/workspace",
  });

  console.log("r", r.stderr);
  console.log("r", r.stdout);

  return true;
}
