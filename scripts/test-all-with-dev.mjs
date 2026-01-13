import { spawn } from "node:child_process";
import fs from "node:fs";

const DEFAULT_BASE_URL = "http://localhost:5173";
const BASE_URL = process.env.MACHINEN_BASE_URL ?? DEFAULT_BASE_URL;

function parsePortFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.port) {
      const p = Number.parseInt(u.port, 10);
      return Number.isFinite(p) ? p : null;
    }
    if (u.protocol === "http:") {
      return 80;
    }
    if (u.protocol === "https:") {
      return 443;
    }
  } catch {
    // ignore
  }
  return null;
}

function replacePort(url, port) {
  const u = new URL(url);
  u.port = String(port);
  return u.toString().replace(/\/$/, "");
}

function parseDevVarsValue(key) {
  try {
    const raw = fs.readFileSync(
      new URL("../.dev.vars", import.meta.url),
      "utf8"
    );
    const line = raw
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith(`${key}=`));
    if (!line) {
      return null;
    }
    const v = line.slice(`${key}=`.length).trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

const API_KEY =
  process.env.MACHINEN_API_KEY ?? parseDevVarsValue("API_KEY") ?? "";
const TEST_R2_KEY =
  process.env.MACHINEN_TEST_R2_KEY ??
  parseDevVarsValue("MACHINEN_TEST_R2_KEY") ??
  "";

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

  const forceOwnDev = String(process.env.MACHINEN_TEST_FORCE_DEV ?? "") === "1";
  const alreadyUp = await waitForServer(BASE_URL, 250);

  const effectiveBaseUrl =
    forceOwnDev && alreadyUp ? replacePort(BASE_URL, 5174) : BASE_URL;

  let devProc = null;
  let startedDev = false;

  const shouldStartDev = forceOwnDev ? true : !alreadyUp;

  if (shouldStartDev) {
    const port = parsePortFromUrl(effectiveBaseUrl);
    const devArgs =
      port && port !== 80 && port !== 443
        ? ["-s", "dev", "--", "--port", String(port)]
        : ["-s", "dev"];
    devProc = spawn("pnpm", devArgs, {
      stdio: "inherit",
      shell: false,
      env: {
        ...process.env,
      },
    });
    startedDev = true;

    const ok = await waitForServer(effectiveBaseUrl, 60_000);
    if (!ok) {
      if (devProc) {
        devProc.kill("SIGINT");
      }
      throw new Error(`Dev server did not become ready at ${effectiveBaseUrl}`);
    }
  }

  const env = {
    ...process.env,
    MACHINEN_BASE_URL: effectiveBaseUrl,
    MACHINEN_API_KEY: API_KEY,
    ...(TEST_R2_KEY ? { MACHINEN_TEST_R2_KEY: TEST_R2_KEY } : null),
  };

  const testPatterns = process.argv.slice(2);
  const nodeTestArgs =
    testPatterns.length > 0 ? testPatterns : ["tests/simulation/*.test.mjs"];

  try {
    await run("node", ["--test", ...nodeTestArgs], { env });
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
