import { spawn } from "node:child_process";
import fs from "node:fs";

const BASE_URL = process.env.MACHINEN_BASE_URL ?? "http://localhost:5173";

function parseDevVarsApiKey() {
  try {
    const raw = fs.readFileSync(
      new URL("../.dev.vars", import.meta.url),
      "utf8"
    );
    const line = raw
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("API_KEY="));
    if (!line) {
      return null;
    }
    const v = line.slice("API_KEY=".length).trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

const API_KEY = process.env.MACHINEN_API_KEY ?? parseDevVarsApiKey() ?? "";

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/__debug`, { method: "GET" });
      if (res.ok) {
        return true;
      }
    } catch {
      // ignore
    }
    await sleep(250);
  }
  return false;
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: false,
      ...opts,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ code });
        return;
      }
      reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function main() {
  if (!API_KEY) {
    throw new Error(
      "Missing MACHINEN_API_KEY and could not read API_KEY from .dev.vars"
    );
  }

  const alreadyUp = await waitForServer(BASE_URL, 250);

  let devProc = null;
  let startedDev = false;

  if (!alreadyUp) {
    devProc = spawn("pnpm", ["-s", "dev"], {
      stdio: "inherit",
      shell: false,
      env: {
        ...process.env,
      },
    });
    startedDev = true;

    const ok = await waitForServer(BASE_URL, 60_000);
    if (!ok) {
      if (devProc) {
        devProc.kill("SIGINT");
      }
      throw new Error(`Dev server did not become ready at ${BASE_URL}`);
    }
  }

  try {
    await run("pnpm", ["-s", "test:contract:raw"], {
      env: {
        ...process.env,
        MACHINEN_BASE_URL: BASE_URL,
        MACHINEN_API_KEY: API_KEY,
      },
    });
  } finally {
    if (startedDev && devProc) {
      devProc.kill("SIGINT");
      await sleep(250);
      if (!devProc.killed) {
        devProc.kill("SIGKILL");
      }
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
