import { describe, it, expect } from "vitest";

// ── buildContainerEnv ─────────────────────────────────────────────────────────

describe("buildContainerEnv", () => {
  it("builds the standard env array", async () => {
    const { buildContainerEnv } = await import("./container-config.js");
    const env = buildContainerEnv({
      containerName: "runner-1",
      registrationToken: "tok",
      repoUrl: "http://dtu:3000/org/repo",
      dockerApiUrl: "http://dtu:3000",
      githubRepo: "org/repo",
      headSha: "abc123",
      dtuHost: "host.docker.internal",
      useDirectContainer: false,
    });

    expect(env).toContain("RUNNER_NAME=runner-1");
    expect(env).toContain("GITHUB_REPOSITORY=org/repo");
    expect(env).toContain("MACHINEN_HEAD_SHA=abc123");
    expect(env).toContain("FORCE_COLOR=1");
    // Should NOT include root-mode vars for standard container
    expect(env).not.toContain("RUNNER_ALLOW_RUNASROOT=1");
  });

  it("adds root-mode env vars for direct container injection", async () => {
    const { buildContainerEnv } = await import("./container-config.js");
    const env = buildContainerEnv({
      containerName: "runner-1",
      registrationToken: "tok",
      repoUrl: "http://dtu:3000/org/repo",
      dockerApiUrl: "http://dtu:3000",
      githubRepo: "org/repo",
      dtuHost: "host.docker.internal",
      useDirectContainer: true,
    });

    expect(env).toContain("RUNNER_ALLOW_RUNASROOT=1");
    expect(env).toContain("DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1");
  });
});

// ── buildContainerBinds ───────────────────────────────────────────────────────

describe("buildContainerBinds", () => {
  it("builds standard bind mounts", async () => {
    const { buildContainerBinds } = await import("./container-config.js");
    const binds = buildContainerBinds({
      hostWorkDir: "/tmp/work",
      shimsDir: "/tmp/shims",
      diagDir: "/tmp/diag",
      toolCacheDir: "/tmp/toolcache",
      pnpmStoreDir: "/tmp/pnpm",
      npmCacheDir: "/tmp/npm",
      bunCacheDir: "/tmp/bun",
      playwrightCacheDir: "/tmp/playwright",
      warmModulesDir: "/tmp/warm",
      hostRunnerDir: "/tmp/runner",
      useDirectContainer: false,
    });

    expect(binds).toContain("/tmp/work:/home/runner/_work");
    expect(binds).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(binds).toContain("/tmp/shims:/tmp/machinen-shims");
    expect(binds).toContain("/tmp/warm:/tmp/warm-modules");
    // Standard mode should NOT include runner home bind (but _work bind is expected)
    expect(binds.some((b) => b.endsWith(":/home/runner"))).toBe(false);
  });

  it("includes runner bind mount for direct container", async () => {
    const { buildContainerBinds } = await import("./container-config.js");
    const binds = buildContainerBinds({
      hostWorkDir: "/tmp/work",
      shimsDir: "/tmp/shims",
      diagDir: "/tmp/diag",
      toolCacheDir: "/tmp/toolcache",
      pnpmStoreDir: "/tmp/pnpm",
      npmCacheDir: "/tmp/npm",
      bunCacheDir: "/tmp/bun",
      playwrightCacheDir: "/tmp/playwright",
      warmModulesDir: "/tmp/warm",
      hostRunnerDir: "/tmp/runner",
      useDirectContainer: true,
    });

    expect(binds).toContain("/tmp/runner:/home/runner");
  });
});

// ── buildContainerCmd ─────────────────────────────────────────────────────────

describe("buildContainerCmd", () => {
  it("starts with bash -c for standard containers", async () => {
    const { buildContainerCmd } = await import("./container-config.js");
    const cmd = buildContainerCmd({
      svcPortForwardSnippet: "",
      dtuPort: "3000",
      dtuHost: "localhost",
      useDirectContainer: false,
      containerName: "test-runner",
    });

    expect(cmd[0]).toBe("bash");
    expect(cmd[1]).toBe("-c");
    expect(cmd[2]).toContain("MAYBE_SUDO");
    expect(cmd[2]).toContain("run.sh --once");
  });

  it("starts with -c for direct containers", async () => {
    const { buildContainerCmd } = await import("./container-config.js");
    const cmd = buildContainerCmd({
      svcPortForwardSnippet: "",
      dtuPort: "3000",
      dtuHost: "localhost",
      useDirectContainer: true,
      containerName: "test-runner",
    });

    expect(cmd[0]).toBe("-c");
    expect(cmd).toHaveLength(2);
  });

  it("includes service port forwarding snippet", async () => {
    const { buildContainerCmd } = await import("./container-config.js");
    const cmd = buildContainerCmd({
      svcPortForwardSnippet: "socat TCP-LISTEN:5432,fork TCP:svc-db:5432 & \nsleep 0.3 && ",
      dtuPort: "3000",
      dtuHost: "localhost",
      useDirectContainer: false,
      containerName: "test-runner",
    });

    expect(cmd[2]).toContain("socat TCP-LISTEN:5432");
  });
});

// ── resolveDockerApiUrl ───────────────────────────────────────────────────────

describe("resolveDockerApiUrl", () => {
  it("replaces localhost with the DTU host", async () => {
    const { resolveDockerApiUrl } = await import("./container-config.js");
    expect(resolveDockerApiUrl("http://localhost:3000", "172.17.0.2")).toBe(
      "http://172.17.0.2:3000",
    );
  });

  it("replaces 127.0.0.1 with the DTU host", async () => {
    const { resolveDockerApiUrl } = await import("./container-config.js");
    expect(resolveDockerApiUrl("http://127.0.0.1:3000", "host.docker.internal")).toBe(
      "http://host.docker.internal:3000",
    );
  });
});

// ── signalsDir bind-mount ─────────────────────────────────────────────────────

describe("buildContainerBinds with signalsDir", () => {
  const baseOpts = {
    hostWorkDir: "/tmp/work",
    shimsDir: "/tmp/shims",
    diagDir: "/tmp/diag",
    toolCacheDir: "/tmp/toolcache",
    pnpmStoreDir: "/tmp/pnpm",
    npmCacheDir: "/tmp/npm",
    bunCacheDir: "/tmp/bun",
    playwrightCacheDir: "/tmp/playwright",
    warmModulesDir: "/tmp/warm",
    hostRunnerDir: "/tmp/runner",
    useDirectContainer: false,
  };

  it("includes signals bind-mount when signalsDir is provided", async () => {
    const { buildContainerBinds } = await import("./container-config.js");
    const binds = buildContainerBinds({ ...baseOpts, signalsDir: "/tmp/signals" });
    expect(binds).toContain("/tmp/signals:/tmp/machinen-signals");
  });

  it("omits signals bind-mount when signalsDir is undefined", async () => {
    const { buildContainerBinds } = await import("./container-config.js");
    const binds = buildContainerBinds(baseOpts);
    expect(binds.some((b) => b.includes("machinen-signals"))).toBe(false);
  });
});
