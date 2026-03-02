import Docker from "dockerode";
import type { WorkflowService } from "./workflow-parser.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ServiceContext {
  /** Docker network name shared between runner and services */
  networkName: string;
  /** Running service container IDs */
  containerIds: string[];
  /** Port forwarding lines for the runner's startup script (Python TCP forwarders) */
  portForwards: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse Docker-style health-check flags from the YAML `options:` string.
 * GitHub Actions uses flags like `--health-cmd="..." --health-interval=5s`.
 */
export function parseHealthCheck(options: string): Docker.HealthConfig | undefined {
  const cmdMatch = options.match(/--health-cmd[= ]"([^"]+)"/);
  if (!cmdMatch) {
    return undefined;
  }

  const intervalMatch = options.match(/--health-interval[= ](\d+)s/);
  const timeoutMatch = options.match(/--health-timeout[= ](\d+)s/);
  const retriesMatch = options.match(/--health-retries[= ](\d+)/);

  return {
    Test: ["CMD-SHELL", cmdMatch[1]],
    Interval: parseInt(intervalMatch?.[1] ?? "10", 10) * 1_000_000_000, // nanoseconds
    Timeout: parseInt(timeoutMatch?.[1] ?? "5", 10) * 1_000_000_000,
    Retries: parseInt(retriesMatch?.[1] ?? "3", 10),
  };
}

/**
 * Wait for a container to report "healthy" (Docker HEALTHCHECK).
 * Falls back to a simple ready check after `timeoutMs` milliseconds.
 */
async function waitForHealth(
  docker: Docker,
  containerId: string,
  timeoutMs = 60_000,
  emit?: (line: string) => void,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const info = await docker.getContainer(containerId).inspect();
      const health = (info as any).State?.Health?.Status;

      if (health === "healthy") {
        return;
      }
      if (health === "unhealthy") {
        throw new Error(`Service container ${containerId} is unhealthy`);
      }
      // If no healthcheck defined, just wait for "running" state
      if (!health && info.State?.Running) {
        return;
      }
    } catch (err: any) {
      if (err.message?.includes("unhealthy")) {
        throw err;
      }
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }

  emit?.(`  ⚠ Service health-check timed out after ${timeoutMs / 1000}s — proceeding anyway`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a Docker network, start all service containers, wait for them to be
 * healthy, and return context that `local-job.ts` threads into the runner
 * container config.
 */
export async function startServiceContainers(
  docker: Docker,
  services: WorkflowService[],
  runnerName: string,
  emit?: (line: string) => void,
): Promise<ServiceContext> {
  const networkName = `oa-net-${runnerName}`;
  const containerIds: string[] = [];
  const portForwards: string[] = [];

  // 1. Create a bridge network
  await docker.createNetwork({ Name: networkName, Driver: "bridge" });
  emit?.(`  🔗 Created network ${networkName}`);

  // 2. Start each service
  for (const svc of services) {
    const containerName = `${runnerName}-svc-${svc.name}`;
    emit?.(`  🐳 Starting service: ${svc.name} (${svc.image})`);

    // Build env array
    const envArr = svc.env ? Object.entries(svc.env).map(([k, v]) => `${k}=${v}`) : [];

    // Build health-check config from options string
    const healthConfig = svc.options ? parseHealthCheck(svc.options) : undefined;

    // Parse port mappings (e.g. "3306:3306")
    const portBindings: Record<string, { HostPort: string }[]> = {};
    const exposedPorts: Record<string, Record<string, never>> = {};

    for (const portMapping of svc.ports ?? []) {
      const [hostPort, containerPort] = portMapping.split(":");
      const key = `${containerPort}/tcp`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostPort: hostPort }];
    }

    // Pre-cleanup stale container
    try {
      await docker.getContainer(containerName).remove({ force: true });
    } catch {
      // doesn't exist — fine
    }

    // Pull the image if missing
    try {
      await docker.getImage(svc.image).inspect();
    } catch {
      emit?.(`  📦 Pulling image ${svc.image}...`);
      await new Promise<void>((resolve, reject) => {
        docker.pull(svc.image, (err: any, stream: any) => {
          if (err) {
            return reject(err);
          }
          docker.modem.followProgress(stream, (err: any) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      });
    }

    const container = await docker.createContainer({
      Image: svc.image,
      name: containerName,
      Env: envArr,
      ExposedPorts: exposedPorts,
      Healthcheck: healthConfig,
      HostConfig: {
        NetworkMode: networkName,
        PortBindings: portBindings,
      },
    });

    await container.start();
    containerIds.push(container.id);
    emit?.(`  ✓ Service ${svc.name} started (${container.id.substring(0, 12)})`);

    // Build port-forward commands so localhost:<port> inside the runner reaches the service.
    // Uses the service container's Docker-network hostname (its container name).
    for (const portMapping of svc.ports ?? []) {
      const [hostPort, containerPort] = portMapping.split(":");
      const fwdPort = containerPort || hostPort;
      // Python TCP forwarder (same pattern used for DTU forwarding in local-job.ts)
      portForwards.push(
        `sudo -n python3 -c "
import socket,threading
def fwd(s,d):
 try:
  while True:
   x=s.recv(65536)
   if not x: break
   d.sendall(x)
 except: pass
 finally: s.close();d.close()
def handle(c):
 s=socket.socket();s.connect(('${containerName}',${fwdPort}));threading.Thread(target=fwd,args=(c,s),daemon=True).start();fwd(s,c)
srv=socket.socket();srv.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);srv.bind(('127.0.0.1',${fwdPort}));srv.listen(32)
while True:
 c,_=srv.accept();threading.Thread(target=handle,args=(c,),daemon=True).start()
" &`,
      );
    }
  }

  // 3. Wait for all services to become healthy
  for (let i = 0; i < containerIds.length; i++) {
    const svc = services[i];
    if (svc.options?.includes("--health-cmd")) {
      emit?.(`  ⏳ Waiting for ${svc.name} health check...`);
      await waitForHealth(docker, containerIds[i], 60_000, emit);
      emit?.(`  ✓ ${svc.name} is healthy`);
    }
  }

  return { networkName, containerIds, portForwards };
}

/**
 * Stop and remove all service containers, then remove the shared network.
 */
export async function cleanupServiceContainers(
  docker: Docker,
  ctx: ServiceContext,
  emit?: (line: string) => void,
): Promise<void> {
  for (const id of ctx.containerIds) {
    try {
      const c = docker.getContainer(id);
      await c.stop({ t: 2 }).catch(() => {});
      await c.remove({ force: true });
    } catch {
      // already gone
    }
  }

  try {
    await docker.getNetwork(ctx.networkName).remove();
  } catch {
    // already gone
  }

  emit?.(`  🧹 Cleaned up service containers and network ${ctx.networkName}`);
}
