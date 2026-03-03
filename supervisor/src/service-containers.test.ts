import { describe, it, expect, vi } from "vitest";
import {
  startServiceContainers,
  cleanupServiceContainers,
  parseHealthCheck,
} from "./service-containers.js";
import type { WorkflowService } from "./workflow-parser.js";

// ─── Mock Docker client ───────────────────────────────────────────────────────

function makeMockContainer(id: string, healthStatus?: string) {
  return {
    id,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue({
      State: {
        Running: true,
        Health: healthStatus ? { Status: healthStatus } : undefined,
      },
    }),
  };
}

function makeMockDocker(opts?: { healthStatus?: string }) {
  const containers = new Map<string, ReturnType<typeof makeMockContainer>>();
  let containerCounter = 0;

  const mockDocker = {
    createNetwork: vi.fn().mockResolvedValue({ id: "net-123" }),
    createContainer: vi.fn().mockImplementation((config: any) => {
      containerCounter++;
      const id = `container-${containerCounter}`;
      const c = makeMockContainer(id, opts?.healthStatus);
      containers.set(config.name || id, c);
      return Promise.resolve(c);
    }),
    getContainer: vi.fn().mockImplementation((nameOrId: string) => {
      const existing = containers.get(nameOrId);
      if (existing) {
        return existing;
      }
      // Return a stub that throws on remove (simulates "doesn't exist")
      return {
        remove: vi.fn().mockRejectedValue(new Error("not found")),
        stop: vi.fn().mockRejectedValue(new Error("not found")),
        inspect: vi.fn().mockResolvedValue({
          State: {
            Running: true,
            Health: opts?.healthStatus ? { Status: opts.healthStatus } : undefined,
          },
        }),
      };
    }),
    getImage: vi.fn().mockReturnValue({
      inspect: vi.fn().mockResolvedValue({}), // image exists
    }),
    getNetwork: vi.fn().mockReturnValue({
      remove: vi.fn().mockResolvedValue(undefined),
    }),
    pull: vi.fn(),
    modem: { followProgress: vi.fn() },
    _containers: containers,
  };

  return mockDocker as any;
}

// ─── parseHealthCheck ─────────────────────────────────────────────────────────

describe("parseHealthCheck", () => {
  it("parses all health-check flags from options string", () => {
    const options = `--health-cmd="mysqladmin ping -h localhost -proot" --health-interval=5s --health-timeout=3s --health-retries=10`;
    const result = parseHealthCheck(options);

    expect(result).toBeDefined();
    expect(result!.Test).toEqual(["CMD-SHELL", "mysqladmin ping -h localhost -proot"]);
    expect(result!.Interval).toBe(5_000_000_000);
    expect(result!.Timeout).toBe(3_000_000_000);
    expect(result!.Retries).toBe(10);
  });

  it("uses defaults when interval/timeout/retries are missing", () => {
    const options = `--health-cmd="curl -f http://localhost/"`;
    const result = parseHealthCheck(options);

    expect(result).toBeDefined();
    expect(result!.Interval).toBe(10_000_000_000); // default 10s
    expect(result!.Timeout).toBe(5_000_000_000); // default 5s
    expect(result!.Retries).toBe(3); // default 3
  });

  it("returns undefined when no --health-cmd is present", () => {
    const result = parseHealthCheck("--some-other-flag");
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    const result = parseHealthCheck("");
    expect(result).toBeUndefined();
  });
});

// ─── startServiceContainers ───────────────────────────────────────────────────

describe("startServiceContainers", () => {
  const MYSQL_SERVICE: WorkflowService = {
    name: "mysql",
    image: "mysql:8.0",
    env: { MYSQL_ROOT_PASSWORD: "root", MYSQL_DATABASE: "test_db" },
    ports: ["3306:3306"],
    options: `--health-cmd="mysqladmin ping" --health-interval=5s --health-timeout=3s --health-retries=10`,
  };

  const REDIS_SERVICE: WorkflowService = {
    name: "redis",
    image: "redis:7",
    ports: ["6379:6379"],
  };

  it("creates a Docker network with the runner name", async () => {
    const docker = makeMockDocker({ healthStatus: "healthy" });
    await startServiceContainers(docker, [REDIS_SERVICE], "oa-runner-42");

    expect(docker.createNetwork).toHaveBeenCalledWith({
      Name: "oa-net-oa-runner-42",
      Driver: "bridge",
    });
  });

  it("creates containers for each service on the shared network", async () => {
    const docker = makeMockDocker({ healthStatus: "healthy" });
    await startServiceContainers(docker, [MYSQL_SERVICE, REDIS_SERVICE], "oa-runner-42");

    expect(docker.createContainer).toHaveBeenCalledTimes(2);

    // First call: MySQL
    const mysqlCall = docker.createContainer.mock.calls[0][0];
    expect(mysqlCall.Image).toBe("mysql:8.0");
    expect(mysqlCall.name).toBe("oa-runner-42-svc-mysql");
    expect(mysqlCall.Env).toContain("MYSQL_ROOT_PASSWORD=root");
    expect(mysqlCall.Env).toContain("MYSQL_DATABASE=test_db");
    expect(mysqlCall.HostConfig.NetworkMode).toBe("oa-net-oa-runner-42");
    expect(mysqlCall.HostConfig.PortBindings).toEqual({
      "3306/tcp": [{ HostPort: "3306" }],
    });
    // Must include a network alias for the short service name so DB_HOST=mysql resolves
    expect(mysqlCall.NetworkingConfig.EndpointsConfig["oa-net-oa-runner-42"].Aliases).toContain(
      "mysql",
    );

    // Second call: Redis
    const redisCall = docker.createContainer.mock.calls[1][0];
    expect(redisCall.Image).toBe("redis:7");
    expect(redisCall.name).toBe("oa-runner-42-svc-redis");
    expect(redisCall.NetworkingConfig.EndpointsConfig["oa-net-oa-runner-42"].Aliases).toContain(
      "redis",
    );
  });

  it("starts all created containers", async () => {
    const docker = makeMockDocker({ healthStatus: "healthy" });
    await startServiceContainers(docker, [MYSQL_SERVICE, REDIS_SERVICE], "oa-runner-42");

    // Both containers should have been started
    for (const [, container] of docker._containers) {
      expect(container.start).toHaveBeenCalledTimes(1);
    }
  });

  it("returns the correct ServiceContext", async () => {
    const docker = makeMockDocker({ healthStatus: "healthy" });
    const ctx = await startServiceContainers(
      docker,
      [MYSQL_SERVICE, REDIS_SERVICE],
      "oa-runner-42",
    );

    expect(ctx.networkName).toBe("oa-net-oa-runner-42");
    expect(ctx.containerIds).toHaveLength(2);
    expect(ctx.containerIds[0]).toBe("container-1");
    expect(ctx.containerIds[1]).toBe("container-2");
  });

  it("generates port-forward commands for each port mapping", async () => {
    const docker = makeMockDocker({ healthStatus: "healthy" });
    const ctx = await startServiceContainers(
      docker,
      [MYSQL_SERVICE, REDIS_SERVICE],
      "oa-runner-42",
    );

    // MySQL has 3306, Redis has 6379 → 2 port forwards
    expect(ctx.portForwards).toHaveLength(2);
    expect(ctx.portForwards[0]).toContain("oa-runner-42-svc-mysql");
    expect(ctx.portForwards[0]).toContain("3306");
    expect(ctx.portForwards[1]).toContain("oa-runner-42-svc-redis");
    expect(ctx.portForwards[1]).toContain("6379");
  });

  it("applies health-check config from options string", async () => {
    const docker = makeMockDocker({ healthStatus: "healthy" });
    await startServiceContainers(docker, [MYSQL_SERVICE], "oa-runner-42");

    const call = docker.createContainer.mock.calls[0][0];
    expect(call.Healthcheck).toBeDefined();
    expect(call.Healthcheck.Test).toEqual(["CMD-SHELL", "mysqladmin ping"]);
    expect(call.Healthcheck.Retries).toBe(10);
  });

  it("does not set Healthcheck when options are absent", async () => {
    const docker = makeMockDocker();
    await startServiceContainers(docker, [REDIS_SERVICE], "oa-runner-42");

    const call = docker.createContainer.mock.calls[0][0];
    expect(call.Healthcheck).toBeUndefined();
  });

  it("handles service with no ports (no port forwards generated)", async () => {
    const docker = makeMockDocker();
    const svc: WorkflowService = { name: "memcached", image: "memcached:latest" };
    const ctx = await startServiceContainers(docker, [svc], "oa-runner-42");

    expect(ctx.portForwards).toHaveLength(0);
  });

  it("pre-cleans stale containers with the same name", async () => {
    const docker = makeMockDocker();
    await startServiceContainers(docker, [REDIS_SERVICE], "oa-runner-42");

    // getContainer is called for pre-cleanup
    expect(docker.getContainer).toHaveBeenCalledWith("oa-runner-42-svc-redis");
  });

  it("calls emit with progress messages", async () => {
    const docker = makeMockDocker({ healthStatus: "healthy" });
    const lines: string[] = [];
    const emit = (line: string) => lines.push(line);

    await startServiceContainers(docker, [MYSQL_SERVICE], "oa-runner-42", emit);

    expect(lines.some((l) => l.includes("Created network"))).toBe(true);
    expect(lines.some((l) => l.includes("Starting service: mysql"))).toBe(true);
    expect(lines.some((l) => l.includes("mysql started"))).toBe(true);
    expect(lines.some((l) => l.includes("Waiting for mysql health check"))).toBe(true);
    expect(lines.some((l) => l.includes("mysql is healthy"))).toBe(true);
  });

  it("sets short service name as a Docker network alias so DB_HOST=mysql resolves on the bridge", async () => {
    // Regression test: service container was named `oa-runner-N-svc-mysql` but the
    // workflow used `DB_HOST: mysql`. On a custom bridge, only container names resolve —
    // not short names — so we must add an alias. Without it, ECONNREFUSED 127.0.0.1:3306.
    const docker = makeMockDocker({ healthStatus: "healthy" });
    await startServiceContainers(docker, [MYSQL_SERVICE], "oa-runner-99");

    const call = docker.createContainer.mock.calls[0][0];
    const networkName = "oa-net-oa-runner-99";

    // The NetworkingConfig must include an EndpointsConfig entry for the network
    expect(call.NetworkingConfig).toBeDefined();
    expect(call.NetworkingConfig.EndpointsConfig).toBeDefined();
    expect(call.NetworkingConfig.EndpointsConfig[networkName]).toBeDefined();

    // The alias must be the short YAML service key (e.g. "mysql"), not the full container name
    const aliases: string[] = call.NetworkingConfig.EndpointsConfig[networkName].Aliases;
    expect(aliases).toContain("mysql");
    expect(aliases).not.toContain("oa-runner-99-svc-mysql"); // full name is NOT the alias
  });

  it("aliases differ per service", async () => {
    const docker = makeMockDocker({ healthStatus: "healthy" });
    await startServiceContainers(docker, [MYSQL_SERVICE, REDIS_SERVICE], "oa-runner-42");

    const networkName = "oa-net-oa-runner-42";
    const mysqlAliases =
      docker.createContainer.mock.calls[0][0].NetworkingConfig.EndpointsConfig[networkName].Aliases;
    const redisAliases =
      docker.createContainer.mock.calls[1][0].NetworkingConfig.EndpointsConfig[networkName].Aliases;

    expect(mysqlAliases).toContain("mysql");
    expect(redisAliases).toContain("redis");
    // Sanity: aliases don't overlap
    expect(mysqlAliases).not.toContain("redis");
    expect(redisAliases).not.toContain("mysql");
  });
});

// ─── cleanupServiceContainers ─────────────────────────────────────────────────

describe("cleanupServiceContainers", () => {
  it("stops and removes all containers, then removes the network", async () => {
    const docker = makeMockDocker();
    const ctx = {
      networkName: "oa-net-test",
      containerIds: ["c1", "c2"],
      portForwards: [],
    };

    await cleanupServiceContainers(docker, ctx);

    // Each container should be stopped and removed
    expect(docker.getContainer).toHaveBeenCalledWith("c1");
    expect(docker.getContainer).toHaveBeenCalledWith("c2");

    // Network should be removed
    expect(docker.getNetwork).toHaveBeenCalledWith("oa-net-test");
  });

  it("doesn't throw if containers are already gone", async () => {
    const docker = makeMockDocker();
    const ctx = {
      networkName: "oa-net-gone",
      containerIds: ["nonexistent"],
      portForwards: [],
    };

    // Should not throw
    await expect(cleanupServiceContainers(docker, ctx)).resolves.toBeUndefined();
  });

  it("emits cleanup message", async () => {
    const docker = makeMockDocker();
    const ctx = {
      networkName: "oa-net-test",
      containerIds: [],
      portForwards: [],
    };
    const lines: string[] = [];

    await cleanupServiceContainers(docker, ctx, (l) => lines.push(l));

    expect(lines.some((l) => l.includes("Cleaned up"))).toBe(true);
    expect(lines.some((l) => l.includes("oa-net-test"))).toBe(true);
  });
});
