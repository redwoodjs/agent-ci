import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  discoverRunnerImage,
  detectMissingToolHint,
  UPSTREAM_RUNNER_IMAGE,
  type ResolvedRunnerImage,
} from "./runner-image.js";

describe("discoverRunnerImage", () => {
  let repoDir: string;
  const originalEnv = process.env.AGENT_CI_RUNNER_IMAGE;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-image-test-"));
    delete process.env.AGENT_CI_RUNNER_IMAGE;
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.AGENT_CI_RUNNER_IMAGE;
    } else {
      process.env.AGENT_CI_RUNNER_IMAGE = originalEnv;
    }
  });

  it("falls back to upstream when nothing is configured", () => {
    const r = discoverRunnerImage(repoDir);
    expect(r.image).toBe(UPSTREAM_RUNNER_IMAGE);
    expect(r.source).toBe("default");
    expect(r.needsBuild).toBe(false);
  });

  it("respects AGENT_CI_RUNNER_IMAGE env var as highest priority", () => {
    fs.mkdirSync(path.join(repoDir, ".github"));
    fs.writeFileSync(
      path.join(repoDir, ".github", "agent-ci.Dockerfile"),
      "FROM ghcr.io/actions/actions-runner:latest\n",
    );
    process.env.AGENT_CI_RUNNER_IMAGE = "my-org/custom:v1";

    const r = discoverRunnerImage(repoDir);
    expect(r.image).toBe("my-org/custom:v1");
    expect(r.source).toBe("env");
    expect(r.needsBuild).toBe(false);
  });

  it("discovers simple form .github/agent-ci.Dockerfile", () => {
    fs.mkdirSync(path.join(repoDir, ".github"));
    fs.writeFileSync(
      path.join(repoDir, ".github", "agent-ci.Dockerfile"),
      "FROM ghcr.io/actions/actions-runner:latest\nRUN echo hi\n",
    );

    const r = discoverRunnerImage(repoDir);
    expect(r.source).toBe("dockerfile-file");
    expect(r.needsBuild).toBe(true);
    expect(r.image).toMatch(/^agent-ci-runner:[0-9a-f]{12}$/);
    expect(r.dockerfilePath).toBe(path.join(repoDir, ".github", "agent-ci.Dockerfile"));
    expect(r.contextDir).toBeUndefined();
  });

  it("discovers directory form .github/agent-ci/Dockerfile with context", () => {
    fs.mkdirSync(path.join(repoDir, ".github", "agent-ci"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".github", "agent-ci", "Dockerfile"),
      "FROM ghcr.io/actions/actions-runner:latest\nCOPY ca.pem /etc/\n",
    );
    fs.writeFileSync(path.join(repoDir, ".github", "agent-ci", "ca.pem"), "fake-cert");

    const r = discoverRunnerImage(repoDir);
    expect(r.source).toBe("dockerfile-dir");
    expect(r.needsBuild).toBe(true);
    expect(r.image).toMatch(/^agent-ci-runner:[0-9a-f]{12}$/);
    expect(r.contextDir).toBe(path.join(repoDir, ".github", "agent-ci"));
  });

  it("directory form takes precedence over simple form", () => {
    fs.mkdirSync(path.join(repoDir, ".github", "agent-ci"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".github", "agent-ci", "Dockerfile"),
      "FROM ghcr.io/actions/actions-runner:latest\n",
    );
    fs.writeFileSync(
      path.join(repoDir, ".github", "agent-ci.Dockerfile"),
      "FROM ghcr.io/actions/actions-runner:latest\nRUN echo wrong\n",
    );

    const r = discoverRunnerImage(repoDir);
    expect(r.source).toBe("dockerfile-dir");
  });

  it("hash is stable across identical contents", () => {
    fs.mkdirSync(path.join(repoDir, ".github"));
    const contents = "FROM ghcr.io/actions/actions-runner:latest\nRUN echo stable\n";
    fs.writeFileSync(path.join(repoDir, ".github", "agent-ci.Dockerfile"), contents);
    const r1 = discoverRunnerImage(repoDir);

    // Overwrite with the same contents
    fs.writeFileSync(path.join(repoDir, ".github", "agent-ci.Dockerfile"), contents);
    const r2 = discoverRunnerImage(repoDir);

    expect(r1.image).toBe(r2.image);
  });

  it("hash changes when Dockerfile contents change", () => {
    fs.mkdirSync(path.join(repoDir, ".github"));
    fs.writeFileSync(
      path.join(repoDir, ".github", "agent-ci.Dockerfile"),
      "FROM ghcr.io/actions/actions-runner:latest\nRUN echo a\n",
    );
    const r1 = discoverRunnerImage(repoDir);

    fs.writeFileSync(
      path.join(repoDir, ".github", "agent-ci.Dockerfile"),
      "FROM ghcr.io/actions/actions-runner:latest\nRUN echo b\n",
    );
    const r2 = discoverRunnerImage(repoDir);

    expect(r1.image).not.toBe(r2.image);
  });

  it("hash changes when a context file changes (directory form)", () => {
    fs.mkdirSync(path.join(repoDir, ".github", "agent-ci"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".github", "agent-ci", "Dockerfile"),
      "FROM ghcr.io/actions/actions-runner:latest\nCOPY data /tmp/\n",
    );
    fs.writeFileSync(path.join(repoDir, ".github", "agent-ci", "data"), "v1");
    const r1 = discoverRunnerImage(repoDir);

    fs.writeFileSync(path.join(repoDir, ".github", "agent-ci", "data"), "v2");
    const r2 = discoverRunnerImage(repoDir);

    expect(r1.image).not.toBe(r2.image);
  });

  it("ignores empty AGENT_CI_RUNNER_IMAGE", () => {
    process.env.AGENT_CI_RUNNER_IMAGE = "   ";
    const r = discoverRunnerImage(repoDir);
    expect(r.source).toBe("default");
  });
});

describe("detectMissingToolHint", () => {
  const defaultResolved: ResolvedRunnerImage = {
    image: UPSTREAM_RUNNER_IMAGE,
    source: "default",
    sourceLabel: "built-in default",
    needsBuild: false,
  };

  it("matches cargo linker `cc` not found", () => {
    const hint = detectMissingToolHint(
      "error: linker `cc` not found\n  = note: No such file",
      defaultResolved,
    );
    expect(hint).not.toBeNull();
    expect(hint).toContain("cc");
    expect(hint).toContain("build-essential");
    expect(hint).toContain(".github/agent-ci.Dockerfile");
  });

  it("matches bare `cc: command not found`", () => {
    const hint = detectMissingToolHint("sh: cc: command not found", defaultResolved);
    expect(hint).toContain("cc");
  });

  it("matches `make: command not found`", () => {
    const hint = detectMissingToolHint("/bin/sh: make: command not found", defaultResolved);
    expect(hint).not.toBeNull();
    expect(hint).toContain("make");
  });

  it("matches pkg-config", () => {
    const hint = detectMissingToolHint("pkg-config: command not found", defaultResolved);
    expect(hint).toContain("pkg-config");
  });

  it("returns null when the user is on a custom image (env var)", () => {
    const resolved: ResolvedRunnerImage = {
      image: "my-org/custom:v1",
      source: "env",
      sourceLabel: "AGENT_CI_RUNNER_IMAGE",
      needsBuild: false,
    };
    const hint = detectMissingToolHint("error: linker `cc` not found", resolved);
    expect(hint).toBeNull();
  });

  it("returns null when the user already has a Dockerfile configured", () => {
    const resolved: ResolvedRunnerImage = {
      image: "agent-ci-runner:abc123def456",
      source: "dockerfile-file",
      sourceLabel: ".github/agent-ci.Dockerfile",
      needsBuild: true,
      dockerfilePath: "/fake/.github/agent-ci.Dockerfile",
    };
    const hint = detectMissingToolHint("error: linker `cc` not found", resolved);
    expect(hint).toBeNull();
  });

  it("returns null for unrelated failures", () => {
    const hint = detectMissingToolHint("Error: assertion failed at line 42", defaultResolved);
    expect(hint).toBeNull();
  });
});
