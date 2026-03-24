import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncFileToWorkspace } from "./sync.js";

describe("syncFileToWorkspace", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-file-test-"));
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupRunWorkspace(runDir: string, repoName: string): string {
    const workspaceDir = path.join(runDir, "work", repoName, repoName);
    fs.mkdirSync(workspaceDir, { recursive: true });
    return workspaceDir;
  }

  it("copies a repo file into the nested run workspace", () => {
    const repoDir = path.join(tmpDir, "repo");
    const runDir = path.join(tmpDir, "run");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
    const workspaceDir = setupRunWorkspace(runDir, "repo");

    const sourceFile = path.join(repoDir, "src", "index.ts");
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, "export const x = 1;\n", "utf8");

    process.chdir(repoDir);
    syncFileToWorkspace(runDir, sourceFile);

    const destFile = path.join(workspaceDir, "src", "index.ts");
    expect(fs.existsSync(destFile)).toBe(true);
    expect(fs.readFileSync(destFile, "utf8")).toBe("export const x = 1;\n");
  });

  it("does not sync files outside of the repo root", () => {
    const repoDir = path.join(tmpDir, "repo");
    const runDir = path.join(tmpDir, "run");
    const outsideDir = path.join(tmpDir, "outside");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
    const workspaceDir = setupRunWorkspace(runDir, "repo");

    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(outsideFile, "do-not-copy\n", "utf8");

    process.chdir(repoDir);
    syncFileToWorkspace(runDir, outsideFile);

    expect(fs.existsSync(path.join(workspaceDir, "secret.txt"))).toBe(false);
  });
});
