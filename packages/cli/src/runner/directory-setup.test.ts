import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

// ── ensureWorldWritable ───────────────────────────────────────────────────────

describe("ensureWorldWritable", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dirsetup-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sets all directories to 0o777", async () => {
    const { ensureWorldWritable } = await import("./directory-setup.js");
    const dir1 = path.join(tmpDir, "a");
    const dir2 = path.join(tmpDir, "b");
    fs.mkdirSync(dir1);
    fs.mkdirSync(dir2);

    // Start with restrictive permissions
    fs.chmodSync(dir1, 0o700);
    fs.chmodSync(dir2, 0o700);

    ensureWorldWritable([dir1, dir2]);

    expect(fs.statSync(dir1).mode & 0o777).toBe(0o777);
    expect(fs.statSync(dir2).mode & 0o777).toBe(0o777);
  });

  it("does not throw on non-existent directories", async () => {
    const { ensureWorldWritable } = await import("./directory-setup.js");
    expect(() => ensureWorldWritable(["/nonexistent/path"])).not.toThrow();
  });
});

// ── Package manager detection + conditional cache dirs ────────────────────────

describe("createRunDirectories — PM-scoped caching", () => {
  let repoDir: string;
  let runDir: string;

  /** Scaffold a git repo with a workflow file and the given lockfile. */
  function makeFixture(lockfileName: string, lockfileContent: string) {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-fixture-"));
    runDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-rundir-"));

    execSync("git init", { cwd: repoDir, stdio: "pipe" });
    execSync('git config user.name "test"', { cwd: repoDir, stdio: "pipe" });
    execSync('git config user.email "t@t.com"', { cwd: repoDir, stdio: "pipe" });

    // Lockfile
    fs.writeFileSync(path.join(repoDir, lockfileName), lockfileContent);

    // Minimal workflow
    const wfDir = path.join(repoDir, ".github", "workflows");
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(
      path.join(wfDir, "ci.yml"),
      "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n",
    );

    execSync("git add -A", { cwd: repoDir, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: repoDir, stdio: "pipe" });
  }

  afterEach(() => {
    if (repoDir) {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
    if (runDir) {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("npm: only creates npm cache dir, not pnpm or bun", async () => {
    makeFixture("package-lock.json", '{"lockfileVersion":3}');
    const { createRunDirectories } = await import("./directory-setup.js");

    const dirs = createRunDirectories({
      runDir,
      githubRepo: "test/npm-project",
      workflowPath: path.join(repoDir, ".github", "workflows", "ci.yml"),
    });

    expect(dirs.detectedPM).toBe("npm");
    expect(dirs.npmCacheDir).toBeDefined();
    expect(dirs.pnpmStoreDir).toBeUndefined();
    expect(dirs.bunCacheDir).toBeUndefined();
  });

  it("pnpm: only creates pnpm cache dir, not npm or bun", async () => {
    makeFixture("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    const { createRunDirectories } = await import("./directory-setup.js");

    const dirs = createRunDirectories({
      runDir,
      githubRepo: "test/pnpm-project",
      workflowPath: path.join(repoDir, ".github", "workflows", "ci.yml"),
    });

    expect(dirs.detectedPM).toBe("pnpm");
    expect(dirs.pnpmStoreDir).toBeDefined();
    expect(dirs.npmCacheDir).toBeUndefined();
    expect(dirs.bunCacheDir).toBeUndefined();
  });

  it("yarn: creates no PM-specific cache dirs (no dedicated mount)", async () => {
    makeFixture("yarn.lock", "# yarn lockfile v1\n");
    const { createRunDirectories } = await import("./directory-setup.js");

    const dirs = createRunDirectories({
      runDir,
      githubRepo: "test/yarn-project",
      workflowPath: path.join(repoDir, ".github", "workflows", "ci.yml"),
    });

    expect(dirs.detectedPM).toBe("yarn");
    expect(dirs.pnpmStoreDir).toBeUndefined();
    expect(dirs.npmCacheDir).toBeUndefined();
    expect(dirs.bunCacheDir).toBeUndefined();
  });

  it("bun: only creates bun cache dir, not pnpm or npm", async () => {
    makeFixture("bun.lock", '{"lockfileVersion":0}');
    const { createRunDirectories } = await import("./directory-setup.js");

    const dirs = createRunDirectories({
      runDir,
      githubRepo: "test/bun-project",
      workflowPath: path.join(repoDir, ".github", "workflows", "ci.yml"),
    });

    expect(dirs.detectedPM).toBe("bun");
    expect(dirs.bunCacheDir).toBeDefined();
    expect(dirs.pnpmStoreDir).toBeUndefined();
    expect(dirs.npmCacheDir).toBeUndefined();
  });

  it("no lockfile: creates all PM cache dirs (fallback)", async () => {
    // Repo with no lockfile at all
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-fixture-"));
    runDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-rundir-"));
    execSync("git init", { cwd: repoDir, stdio: "pipe" });
    execSync('git config user.name "test"', { cwd: repoDir, stdio: "pipe" });
    execSync('git config user.email "t@t.com"', { cwd: repoDir, stdio: "pipe" });
    const wfDir = path.join(repoDir, ".github", "workflows");
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(
      path.join(wfDir, "ci.yml"),
      "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n",
    );
    execSync("git add -A", { cwd: repoDir, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: repoDir, stdio: "pipe" });

    const { createRunDirectories } = await import("./directory-setup.js");

    const dirs = createRunDirectories({
      runDir,
      githubRepo: "test/no-pm-project",
      workflowPath: path.join(repoDir, ".github", "workflows", "ci.yml"),
    });

    expect(dirs.detectedPM).toBeNull();
    expect(dirs.pnpmStoreDir).toBeDefined();
    expect(dirs.npmCacheDir).toBeDefined();
    expect(dirs.bunCacheDir).toBeDefined();
  });
});

// ── Bind mounts respect detected PM ──────────────────────────────────────────

describe("buildContainerBinds — PM-scoped mounts", () => {
  it("npm project: only mounts .npm, no .pnpm-store or .bun", async () => {
    const { buildContainerBinds } = await import("../docker/container-config.js");

    const binds = buildContainerBinds({
      hostWorkDir: "/tmp/work",
      shimsDir: "/tmp/shims",
      diagDir: "/tmp/diag",
      toolCacheDir: "/tmp/toolcache",
      npmCacheDir: "/tmp/npm-cache",
      // pnpmStoreDir and bunCacheDir intentionally omitted (npm project)
      playwrightCacheDir: "/tmp/playwright",
      warmModulesDir: "/tmp/warm",
      hostRunnerDir: "/tmp/runner",
      useDirectContainer: false,
      githubRepo: "org/repo",
    });

    expect(binds).toContain("/tmp/npm-cache:/home/runner/.npm");
    expect(binds.some((b) => b.includes(".pnpm-store"))).toBe(false);
    expect(binds.some((b) => b.includes(".bun/install"))).toBe(false);
  });

  it("pnpm project: only mounts .pnpm-store, no .npm or .bun", async () => {
    const { buildContainerBinds } = await import("../docker/container-config.js");

    const binds = buildContainerBinds({
      hostWorkDir: "/tmp/work",
      shimsDir: "/tmp/shims",
      diagDir: "/tmp/diag",
      toolCacheDir: "/tmp/toolcache",
      pnpmStoreDir: "/tmp/pnpm-store",
      // npmCacheDir and bunCacheDir intentionally omitted (pnpm project)
      playwrightCacheDir: "/tmp/playwright",
      warmModulesDir: "/tmp/warm",
      hostRunnerDir: "/tmp/runner",
      useDirectContainer: false,
      githubRepo: "org/repo",
    });

    expect(binds).toContain("/tmp/pnpm-store:/home/runner/_work/.pnpm-store");
    expect(binds.some((b) => b.includes("/.npm"))).toBe(false);
    expect(binds.some((b) => b.includes(".bun/install"))).toBe(false);
  });

  it("bun project: only mounts .bun, no .pnpm-store or .npm", async () => {
    const { buildContainerBinds } = await import("../docker/container-config.js");

    const binds = buildContainerBinds({
      hostWorkDir: "/tmp/work",
      shimsDir: "/tmp/shims",
      diagDir: "/tmp/diag",
      toolCacheDir: "/tmp/toolcache",
      bunCacheDir: "/tmp/bun-cache",
      // pnpmStoreDir and npmCacheDir intentionally omitted (bun project)
      playwrightCacheDir: "/tmp/playwright",
      warmModulesDir: "/tmp/warm",
      hostRunnerDir: "/tmp/runner",
      useDirectContainer: false,
      githubRepo: "org/repo",
    });

    expect(binds).toContain("/tmp/bun-cache:/home/runner/.bun/install/cache");
    expect(binds.some((b) => b.includes(".pnpm-store"))).toBe(false);
    expect(binds.some((b) => b.includes("/.npm"))).toBe(false);
  });

  it("yarn project: no PM-specific mounts at all", async () => {
    const { buildContainerBinds } = await import("../docker/container-config.js");

    const binds = buildContainerBinds({
      hostWorkDir: "/tmp/work",
      shimsDir: "/tmp/shims",
      diagDir: "/tmp/diag",
      toolCacheDir: "/tmp/toolcache",
      // all PM dirs omitted (yarn has no dedicated mount)
      playwrightCacheDir: "/tmp/playwright",
      warmModulesDir: "/tmp/warm",
      hostRunnerDir: "/tmp/runner",
      useDirectContainer: false,
      githubRepo: "org/repo",
    });

    expect(binds.some((b) => b.includes(".pnpm-store"))).toBe(false);
    expect(binds.some((b) => b.includes("/.npm"))).toBe(false);
    expect(binds.some((b) => b.includes(".bun/install"))).toBe(false);
  });
});
