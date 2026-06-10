import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

describe("writePackageManagerShims", () => {
  let tmpDir: string;
  let shimsDir: string;
  let binDir: string;
  let repoDir: string;
  let toolCacheDir: string;
  let callsFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ci-pm-shim-"));
    shimsDir = path.join(tmpDir, "shims");
    binDir = path.join(tmpDir, "bin");
    repoDir = path.join(tmpDir, "repo");
    toolCacheDir = path.join(tmpDir, "toolcache");
    callsFile = path.join(tmpDir, "calls.log");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(toolCacheDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFakeNpm(scriptBody: string): string {
    const realNpm = path.join(binDir, "npm-real");
    fs.writeFileSync(realNpm, `#!/usr/bin/env bash\nset -euo pipefail\n${scriptBody}\n`, {
      mode: 0o755,
    });
    return realNpm;
  }

  function shimEnv(realNpm: string, agentCiLocal = "true"): NodeJS.ProcessEnv {
    return {
      ...process.env,
      AGENT_CI_LOCAL: agentCiLocal,
      AGENT_CI_LOCKFILE_HASH: "lockhash",
      AGENT_CI_ORIGINAL_PATH: binDir,
      AGENT_CI_REAL_NPM: realNpm,
      GITHUB_REPOSITORY: "org/repo",
      RUNNER_TOOL_CACHE: toolCacheDir,
    };
  }

  it("writes executable shims for common package managers", async () => {
    const { writePackageManagerShims } = await import("./package-manager-shim.ts");

    writePackageManagerShims(shimsDir);

    for (const pm of ["npm", "pnpm", "yarn", "bun"]) {
      const stat = fs.statSync(path.join(shimsDir, pm));
      expect(stat.mode & 0o111).not.toBe(0);
    }
    expect(fs.readFileSync(path.join(shimsDir, "bash-env"), "utf8")).toContain(
      'pnpm() { /tmp/agent-ci-shims/pnpm "$@"; }',
    );
  });

  it("reuses a warm node_modules marker instead of repeating npm ci", async () => {
    const { writePackageManagerShims } = await import("./package-manager-shim.ts");
    writePackageManagerShims(shimsDir);
    const realNpm = writeFakeNpm(
      `echo "real:$*" >> "${callsFile}"\nmkdir -p node_modules\ntouch node_modules/.package-lock.json`,
    );
    const npmShim = path.join(shimsDir, "npm");

    execFileSync(npmShim, ["ci"], { cwd: repoDir, env: shimEnv(realNpm) });
    const secondOutput = execFileSync(npmShim, ["ci"], {
      cwd: repoDir,
      env: shimEnv(realNpm),
      encoding: "utf8",
    });

    expect(fs.readFileSync(callsFile, "utf8").trim().split("\n")).toEqual(["real:ci"]);
    expect(secondOutput).toContain("Reusing warm node_modules");
  });

  it("serializes concurrent npm ci calls so only one writes the shared node_modules", async () => {
    const { writePackageManagerShims } = await import("./package-manager-shim.ts");
    writePackageManagerShims(shimsDir);
    const activeFile = path.join(tmpDir, "active");
    const realNpm = writeFakeNpm(
      `if [ -f "${activeFile}" ]; then echo overlap >> "${callsFile}"; fi\n` +
        `touch "${activeFile}"\n` +
        `sleep 0.2\n` +
        `mkdir -p node_modules\n` +
        `touch node_modules/.package-lock.json\n` +
        `rm -f "${activeFile}"\n` +
        `echo "real:$*" >> "${callsFile}"`,
    );
    const npmShim = path.join(shimsDir, "npm");
    const env = shimEnv(realNpm);

    await Promise.all([
      execFileP(npmShim, ["ci"], { cwd: repoDir, env }),
      execFileP(npmShim, ["ci"], { cwd: repoDir, env }),
    ]);

    expect(fs.readFileSync(callsFile, "utf8").trim().split("\n")).toEqual(["real:ci"]);
  });

  it("serializes but does not skip workspace installs because they write links outside root node_modules", async () => {
    const { writePackageManagerShims } = await import("./package-manager-shim.ts");
    writePackageManagerShims(shimsDir);
    fs.writeFileSync(path.join(repoDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    const realNpm = writeFakeNpm(
      `echo "real:$*" >> "${callsFile}"\nmkdir -p node_modules\ntouch node_modules/.modules.yaml`,
    );
    const npmShim = path.join(shimsDir, "npm");

    execFileSync(npmShim, ["ci"], { cwd: repoDir, env: shimEnv(realNpm) });
    execFileSync(npmShim, ["ci"], { cwd: repoDir, env: shimEnv(realNpm) });

    expect(fs.readFileSync(callsFile, "utf8").trim().split("\n")).toEqual(["real:ci", "real:ci"]);
  });

  it("finds package managers that setup actions add to the current PATH", async () => {
    const { writePackageManagerShims } = await import("./package-manager-shim.ts");
    writePackageManagerShims(shimsDir);
    const pnpmBin = path.join(binDir, "pnpm");
    fs.writeFileSync(
      pnpmBin,
      `#!/usr/bin/env bash\nset -euo pipefail\necho "real-pnpm:$*" >> "${callsFile}"\nmkdir -p node_modules\ntouch node_modules/.modules.yaml\n`,
      { mode: 0o755 },
    );
    const pnpmShim = path.join(shimsDir, "pnpm");

    execFileSync(pnpmShim, ["install"], {
      cwd: repoDir,
      env: {
        ...shimEnv(""),
        AGENT_CI_REAL_NPM: undefined,
        PATH: `${shimsDir}:${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    expect(fs.readFileSync(callsFile, "utf8").trim()).toBe("real-pnpm:install");
  });

  it("passes install commands through unchanged outside local Agent CI", async () => {
    const { writePackageManagerShims } = await import("./package-manager-shim.ts");
    writePackageManagerShims(shimsDir);
    const realNpm = writeFakeNpm(`echo "real:$*" >> "${callsFile}"`);
    const npmShim = path.join(shimsDir, "npm");

    execFileSync(npmShim, ["ci"], { cwd: repoDir, env: shimEnv(realNpm, "false") });
    execFileSync(npmShim, ["ci"], { cwd: repoDir, env: shimEnv(realNpm, "false") });

    expect(fs.readFileSync(callsFile, "utf8").trim().split("\n")).toEqual(["real:ci", "real:ci"]);
  });
});
