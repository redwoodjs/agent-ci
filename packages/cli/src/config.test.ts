import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  config,
  getFirstRemoteUrl,
  loadMachineSecrets,
  parseRepoSlug,
  resolveRepoSlug,
} from "./config.js";

describe("parseRepoSlug", () => {
  it.each([
    ["https://github.com/redwoodjs/agent-ci.git", "redwoodjs/agent-ci"],
    ["https://github.com/redwoodjs/agent-ci", "redwoodjs/agent-ci"],
    ["https://github.com/redwoodjs/agent-ci/", "redwoodjs/agent-ci"],
    ["git@github.com:redwoodjs/agent-ci.git", "redwoodjs/agent-ci"],
    ["git@github.com:redwoodjs/agent-ci", "redwoodjs/agent-ci"],
    ["ssh://git@github.com/redwoodjs/agent-ci.git", "redwoodjs/agent-ci"],
    ["ssh://git@github.com/redwoodjs/agent-ci", "redwoodjs/agent-ci"],
    ["ssh://git@github.com:22/redwoodjs/agent-ci.git", "redwoodjs/agent-ci"],
    ["https://github.example.com/redwoodjs/agent-ci.git", "redwoodjs/agent-ci"],
    ["git@github.example.com:redwoodjs/agent-ci.git", "redwoodjs/agent-ci"],
  ])("parses %s → %s", (url, expected) => {
    expect(parseRepoSlug(url)).toBe(expected);
  });

  it("returns null for unparseable URLs", () => {
    expect(parseRepoSlug("not-a-url")).toBeNull();
    expect(parseRepoSlug("")).toBeNull();
  });
});

describe("getFirstRemoteUrl", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
    execSync("git init", { cwd: tmpDir, stdio: "pipe" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns origin URL when origin exists", () => {
    execSync("git remote add origin https://github.com/test/repo.git", {
      cwd: tmpDir,
      stdio: "pipe",
    });
    expect(getFirstRemoteUrl(tmpDir)).toBe("https://github.com/test/repo.git");
  });

  it("falls back to first remote when origin does not exist", () => {
    execSync("git remote add upstream https://github.com/test/upstream.git", {
      cwd: tmpDir,
      stdio: "pipe",
    });
    expect(getFirstRemoteUrl(tmpDir)).toBe("https://github.com/test/upstream.git");
  });

  it("prefers origin over other remotes", () => {
    execSync("git remote add upstream https://github.com/test/upstream.git", {
      cwd: tmpDir,
      stdio: "pipe",
    });
    execSync("git remote add origin https://github.com/test/origin.git", {
      cwd: tmpDir,
      stdio: "pipe",
    });
    expect(getFirstRemoteUrl(tmpDir)).toBe("https://github.com/test/origin.git");
  });

  it("returns null when no remotes exist", () => {
    expect(getFirstRemoteUrl(tmpDir)).toBeNull();
  });

  it("returns null for non-git directory", () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "no-git-"));
    try {
      expect(getFirstRemoteUrl(nonGitDir)).toBeNull();
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });
});

describe("resolveRepoSlug", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
    execSync("git init", { cwd: tmpDir, stdio: "pipe" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects owner/repo from remote URL", () => {
    execSync("git remote add origin https://github.com/acme/widgets.git", {
      cwd: tmpDir,
      stdio: "pipe",
    });
    expect(resolveRepoSlug(tmpDir)).toBe("acme/widgets");
  });

  it("detects owner/repo from SSH remote", () => {
    execSync("git remote add origin git@github.com:acme/widgets.git", {
      cwd: tmpDir,
      stdio: "pipe",
    });
    expect(resolveRepoSlug(tmpDir)).toBe("acme/widgets");
  });

  it("throws when no remotes exist and no fallback given", () => {
    expect(() => resolveRepoSlug(tmpDir)).toThrow(/Could not detect GitHub repository/);
  });

  it("returns fallback when no remotes exist", () => {
    expect(resolveRepoSlug(tmpDir, "org/fallback")).toBe("org/fallback");
  });

  it("throws for non-git directory without fallback", () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "no-git-"));
    try {
      expect(() => resolveRepoSlug(nonGitDir)).toThrow(/Could not detect GitHub repository/);
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it("uses non-origin remote when origin is absent", () => {
    execSync("git remote add upstream https://github.com/acme/upstream.git", {
      cwd: tmpDir,
      stdio: "pipe",
    });
    expect(resolveRepoSlug(tmpDir)).toBe("acme/upstream");
  });
});

describe("GITHUB_REPO env var override priority", () => {
  let tmpDir: string;
  let savedRepo: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
    execSync("git init", { cwd: tmpDir, stdio: "pipe" });
    savedRepo = config.GITHUB_REPO;
  });

  afterEach(() => {
    config.GITHUB_REPO = savedRepo;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("env var overrides auto-detection", () => {
    execSync("git remote add origin https://github.com/detected/repo.git", {
      cwd: tmpDir,
      stdio: "pipe",
    });
    config.GITHUB_REPO = "override/from-env";

    // Replicate cli.ts priority: env var ?? auto-detect
    const result = config.GITHUB_REPO ?? resolveRepoSlug(tmpDir);
    expect(result).toBe("override/from-env");
  });

  it("auto-detects when env var is not set", () => {
    execSync("git remote add origin https://github.com/detected/repo.git", {
      cwd: tmpDir,
      stdio: "pipe",
    });
    config.GITHUB_REPO = undefined;

    const result = config.GITHUB_REPO ?? resolveRepoSlug(tmpDir);
    expect(result).toBe("detected/repo");
  });

  it("throws when neither env var nor remote is available", () => {
    config.GITHUB_REPO = undefined;

    expect(() => {
      return config.GITHUB_REPO ?? resolveRepoSlug(tmpDir);
    }).toThrow(/Could not detect GitHub repository/);
  });
});

// ─── loadMachineSecrets ──────────────────────────────────────────────────────

describe("loadMachineSecrets", () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  function saveEnv(...keys: string[]) {
    for (const k of keys) {
      savedEnv[k] = process.env[k];
    }
  }

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  function writeEnvFile(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-test-"));
    fs.writeFileSync(path.join(tmpDir, ".env.agent-ci"), content);
    return tmpDir;
  }

  function makeTmpDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-test-"));
    return tmpDir;
  }

  it("returns empty object when .env.agent-ci does not exist", () => {
    const dir = makeTmpDir();
    expect(loadMachineSecrets(dir)).toEqual({});
  });

  it("parses KEY=VALUE pairs from file", () => {
    const dir = writeEnvFile("FOO=bar\nBAZ=qux\n");
    expect(loadMachineSecrets(dir)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("fills missing secrets from process.env when envFallbackKeys provided", () => {
    const dir = makeTmpDir();
    saveEnv("TEST_SECRET_ABC");
    process.env.TEST_SECRET_ABC = "from-env";

    const secrets = loadMachineSecrets(dir, ["TEST_SECRET_ABC"]);
    expect(secrets.TEST_SECRET_ABC).toBe("from-env");
  });

  it("file values take precedence over process.env", () => {
    const dir = writeEnvFile("MY_TOKEN=from-file\n");
    saveEnv("MY_TOKEN");
    process.env.MY_TOKEN = "from-env";

    const secrets = loadMachineSecrets(dir, ["MY_TOKEN"]);
    expect(secrets.MY_TOKEN).toBe("from-file");
  });

  it("does not pull from process.env for keys not in envFallbackKeys", () => {
    const dir = makeTmpDir();
    saveEnv("UNRELATED_VAR");
    process.env.UNRELATED_VAR = "should-not-appear";

    const secrets = loadMachineSecrets(dir, ["OTHER_KEY"]);
    expect(secrets.UNRELATED_VAR).toBeUndefined();
    expect(secrets.OTHER_KEY).toBeUndefined();
  });

  it("does not pull from process.env when envFallbackKeys is omitted", () => {
    const dir = makeTmpDir();
    saveEnv("SOME_SECRET");
    process.env.SOME_SECRET = "env-value";

    const secrets = loadMachineSecrets(dir);
    expect(secrets.SOME_SECRET).toBeUndefined();
  });

  it("merges file secrets and env fallbacks", () => {
    const dir = writeEnvFile("FROM_FILE=file-val\n");
    saveEnv("FROM_ENV");
    process.env.FROM_ENV = "env-val";

    const secrets = loadMachineSecrets(dir, ["FROM_FILE", "FROM_ENV"]);
    expect(secrets).toEqual({ FROM_FILE: "file-val", FROM_ENV: "env-val" });
  });
});
