import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { prepareWorkspace } from "./workspace.js";

describe("prepareWorkspace", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-test-"));
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("copies workflow file into workspace even when archiving a fixed SHA", () => {
    const repoDir = path.join(tmpDir, "repo");
    const workspaceDir = path.join(tmpDir, "workspace");

    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    execSync("git init", { cwd: repoDir, stdio: "pipe" });
    execSync('git config user.name "test"', { cwd: repoDir, stdio: "pipe" });
    execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: "pipe" });

    fs.writeFileSync(path.join(repoDir, "README.md"), "base\n", "utf8");
    execSync("git add README.md", { cwd: repoDir, stdio: "pipe" });
    execSync('git commit -m "base"', { cwd: repoDir, stdio: "pipe" });

    const sha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf8" }).trim();

    const workflowPath = path.join(repoDir, ".github", "workflows", "ci.yml");
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.writeFileSync(
      workflowPath,
      "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n",
      "utf8",
    );

    prepareWorkspace({
      workflowPath,
      headSha: sha,
      githubRepo: "owner/repo",
      workspaceDir,
    });

    const copiedWorkflow = path.join(workspaceDir, ".github", "workflows", "ci.yml");
    expect(fs.existsSync(copiedWorkflow)).toBe(true);
    expect(fs.readFileSync(copiedWorkflow, "utf8")).toContain("name: CI");
  });

  it("overwrites archived workflow with the on-disk workflow content", () => {
    const repoDir = path.join(tmpDir, "repo");
    const workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    execSync("git init", { cwd: repoDir, stdio: "pipe" });
    execSync('git config user.name "test"', { cwd: repoDir, stdio: "pipe" });
    execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: "pipe" });

    const workflowPath = path.join(repoDir, ".github", "workflows", "ci.yml");
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.writeFileSync(workflowPath, "name: Archived\n", "utf8");
    execSync("git add .", { cwd: repoDir, stdio: "pipe" });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: "pipe" });

    const sha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf8" }).trim();
    fs.writeFileSync(workflowPath, "name: OnDisk\n", "utf8");

    prepareWorkspace({
      workflowPath,
      headSha: sha,
      githubRepo: "owner/repo",
      workspaceDir,
    });

    const copiedWorkflow = path.join(workspaceDir, ".github", "workflows", "ci.yml");
    expect(fs.readFileSync(copiedWorkflow, "utf8")).toContain("name: OnDisk");
  });

  it("does not copy workflow paths outside the repo root", () => {
    const repoDir = path.join(tmpDir, "repo");
    const workspaceDir = path.join(tmpDir, "workspace");
    const externalDir = path.join(tmpDir, "external");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(externalDir, { recursive: true });

    execSync("git init", { cwd: repoDir, stdio: "pipe" });
    execSync('git config user.name "test"', { cwd: repoDir, stdio: "pipe" });
    execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: "pipe" });
    fs.writeFileSync(path.join(repoDir, "README.md"), "repo\n", "utf8");
    execSync("git add README.md", { cwd: repoDir, stdio: "pipe" });
    execSync('git commit -m "base"', { cwd: repoDir, stdio: "pipe" });

    const externalWorkflowPath = path.join(externalDir, "outside.yml");
    fs.writeFileSync(externalWorkflowPath, "name: External\n", "utf8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.chdir(repoDir);
    prepareWorkspace({
      workflowPath: externalWorkflowPath,
      githubRepo: "owner/repo",
      workspaceDir,
    });

    expect(fs.existsSync(path.join(workspaceDir, "outside.yml"))).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipping workflow copy outside repo root"),
    );
    warnSpy.mockRestore();
  });
});
