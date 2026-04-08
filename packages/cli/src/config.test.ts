import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config, getFirstRemoteUrl, parseRepoSlug, resolveRepoSlug } from "./config.js";

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
