// ─── DTU host resolution ──────────────────────────────────────────────────────

import fs from "fs";
import { execSync } from "child_process";
import { debugRunner } from "../output/debug.js";

const DEFAULT_DTU_HOST_ALIAS = "host.docker.internal";
const DEFAULT_DOCKER_BRIDGE_GATEWAY = "172.17.0.1";
const DEFAULT_DOCKER_HOST_GATEWAY = "host-gateway";

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function parseCsvEnv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function resolveDtuHost(): Promise<string> {
  const configuredHost = process.env.AGENT_CI_DTU_HOST?.trim();
  if (configuredHost) {
    return configuredHost;
  }

  const isInsideDocker = fs.existsSync("/.dockerenv");
  if (isInsideDocker) {
    try {
      const ip = execSync("hostname -I 2>/dev/null | awk '{print $1}'", {
        encoding: "utf8",
      }).trim();
      if (ip) {
        return ip;
      }
    } catch (error: unknown) {
      debugRunner(`Failed to resolve Docker bridge IP via hostname -I: ${String(error)}`);
    }

    return process.env.AGENT_CI_DOCKER_BRIDGE_GATEWAY?.trim() || DEFAULT_DOCKER_BRIDGE_GATEWAY;
  }

  const configuredGateway = process.env.AGENT_CI_DOCKER_BRIDGE_GATEWAY?.trim();
  if (configuredGateway) {
    debugRunner(
      `Using configured bridge gateway '${configuredGateway}' for DTU host outside Docker`,
    );
    return configuredGateway;
  }

  return DEFAULT_DTU_HOST_ALIAS;
}

export function resolveDockerExtraHosts(dtuHost: string): string[] | undefined {
  const configuredExtraHosts = process.env.AGENT_CI_DOCKER_EXTRA_HOSTS;
  if (configuredExtraHosts !== undefined) {
    const parsed = parseCsvEnv(configuredExtraHosts);
    return parsed.length > 0 ? parsed : undefined;
  }

  if (process.env.AGENT_CI_DOCKER_DISABLE_DEFAULT_EXTRA_HOSTS === "1") {
    return undefined;
  }

  if (dtuHost !== DEFAULT_DTU_HOST_ALIAS) {
    return undefined;
  }

  const gateway = process.env.AGENT_CI_DOCKER_HOST_GATEWAY?.trim() || DEFAULT_DOCKER_HOST_GATEWAY;
  return [`${DEFAULT_DTU_HOST_ALIAS}:${gateway}`];
}

/**
 * Rewrite a DTU URL to be reachable from inside Docker containers.
 */
export function resolveDockerApiUrl(dtuUrl: string, dtuHost: string): string {
  const parsed = new URL(dtuUrl);

  if (isLoopbackHostname(parsed.hostname)) {
    parsed.hostname = dtuHost;
  }

  const serialized = parsed.toString();
  if (parsed.pathname === "/" && !parsed.search && !parsed.hash && serialized.endsWith("/")) {
    return serialized.slice(0, -1);
  }

  return serialized;
}

// ─── Docker-outside-of-Docker path translation ──────────────────────────────

interface MountMapping {
  containerPath: string;
  hostPath: string;
}

let _mountMappings: MountMapping[] | null = null;

/**
 * When running inside a container with Docker-outside-of-Docker (shared socket),
 * bind mount paths must use HOST paths, not container paths. This function
 * inspects our own container's mounts to build a translation table.
 *
 * Returns [] when running on bare metal (no translation needed).
 */
function getMountMappings(): MountMapping[] {
  if (_mountMappings !== null) {
    return _mountMappings;
  }

  if (!fs.existsSync("/.dockerenv")) {
    _mountMappings = [];
    return _mountMappings;
  }

  try {
    const containerId = fs.readFileSync("/etc/hostname", "utf8").trim();
    const json = execSync(`docker inspect ${containerId}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const data = JSON.parse(json);
    const mounts = data[0]?.Mounts || [];
    _mountMappings = mounts
      .filter((m: { Type: string }) => m.Type === "bind")
      .map((m: { Source: string; Destination: string }) => ({
        hostPath: m.Source,
        containerPath: m.Destination,
      }))
      // Sort longest containerPath first for greedy matching
      .sort((a: MountMapping, b: MountMapping) => b.containerPath.length - a.containerPath.length);
  } catch {
    _mountMappings = [];
  }
  return _mountMappings!;
}

/**
 * Translate a local filesystem path to the corresponding Docker host path.
 * Only applies when running inside a container (Docker-outside-of-Docker).
 * Returns the path unchanged when running on bare metal.
 */
export function toHostPath(localPath: string): string {
  const mappings = getMountMappings();
  for (const { containerPath, hostPath } of mappings) {
    if (localPath === containerPath || localPath.startsWith(containerPath + "/")) {
      return hostPath + localPath.slice(containerPath.length);
    }
  }
  return localPath;
}