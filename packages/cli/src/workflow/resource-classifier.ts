import * as os from "node:os";

export type ResourceFidelity = "faithful" | "degraded";

export interface JobResourceHints {
  labels: string[];
  requestedCpuCount: number | undefined;
  requestedNodeHeapMb: number | undefined;
  matrixJobTotal: number;
  matrixJobIndex: number;
  hasServices: boolean;
  hasContainer: boolean;
}

export interface HostResources {
  cpuCount: number;
  totalMemoryMb: number;
  dockerHost: string;
}

export interface ResourceClassification {
  fidelity: ResourceFidelity;
  summary: string;
  reasons: string[];
  action: string;
}

const MEMORY_SAFETY_MARGIN_MB = 1024;

export interface RunnerSpec {
  cpu: number;
  memoryMb: number;
}

export const RUNNER_SPECS: Record<string, RunnerSpec> = {
  "ubuntu-latest": { cpu: 2, memoryMb: 7168 },
  "ubuntu-latest-4-cores": { cpu: 4, memoryMb: 16384 },
  "ubuntu-latest-8-cores": { cpu: 8, memoryMb: 32768 },
  "ubuntu-latest-16-cores": { cpu: 16, memoryMb: 65536 },
};

export function parseRequestedCpuCount(runsOnLabels: string[]): number | undefined {
  for (let index = runsOnLabels.length - 1; index >= 0; index -= 1) {
    const match = runsOnLabels[index].match(/-(\d+)-cores$/);
    if (match) {
      return Number.parseInt(match[1] ?? "", 10);
    }
  }
  return undefined;
}

export function parseRunnerSpecs(runsOnLabels: string[]): RunnerSpec | undefined {
  for (let index = runsOnLabels.length - 1; index >= 0; index -= 1) {
    const spec = RUNNER_SPECS[runsOnLabels[index] ?? ""];
    if (spec) {
      return spec;
    }
  }

  return undefined;
}

export function collectJobResourceHints(input: {
  labels: string[];
  matrixJobTotal?: number;
  matrixJobIndex?: number;
  hasServices?: boolean;
  hasContainer?: boolean;
}): JobResourceHints {
  const runnerSpecs = parseRunnerSpecs(input.labels);

  return {
    labels: [...input.labels],
    requestedCpuCount: runnerSpecs?.cpu ?? parseRequestedCpuCount(input.labels),
    requestedNodeHeapMb: runnerSpecs?.memoryMb,
    matrixJobTotal: input.matrixJobTotal ?? 1,
    matrixJobIndex: input.matrixJobIndex ?? 0,
    hasServices: input.hasServices ?? false,
    hasContainer: input.hasContainer ?? false,
  };
}

export function getHostResources(): HostResources {
  return {
    cpuCount: os.cpus().length,
    totalMemoryMb: os.totalmem() / (1024 * 1024),
    dockerHost: process.env.DOCKER_HOST || "unix:///var/run/docker.sock",
  };
}

function hasExplicitResourceHints(hints: JobResourceHints): boolean {
  return hints.requestedCpuCount !== undefined || hints.requestedNodeHeapMb !== undefined;
}

function hasUnknownRunnerLabel(hints: JobResourceHints): boolean {
  return hints.requestedNodeHeapMb === undefined && hints.requestedCpuCount === undefined;
}

function buildAction(_dockerHost: string): string {
  return "Use a larger host or adjust the workflow resource hints to fit the available machine.";
}

export function classifyJobResources(
  hints: JobResourceHints,
  host: HostResources,
): ResourceClassification {
  const explicitHintsPresent = hasExplicitResourceHints(hints);
  const hostCpuValid = Number.isFinite(host.cpuCount) && host.cpuCount > 0;
  const hostMemoryValid = Number.isFinite(host.totalMemoryMb) && host.totalMemoryMb > 0;
  const hostInspectable = hostCpuValid && hostMemoryValid;

  const reasons: string[] = [];

  if (
    hostInspectable &&
    hints.requestedCpuCount !== undefined &&
    hints.requestedCpuCount > host.cpuCount
  ) {
    reasons.push(
      `requestedCpuCount (${hints.requestedCpuCount}) exceeds host cpuCount (${host.cpuCount})`,
    );
  }

  if (
    hostInspectable &&
    hints.requestedNodeHeapMb !== undefined &&
    hints.requestedNodeHeapMb + MEMORY_SAFETY_MARGIN_MB > host.totalMemoryMb
  ) {
    reasons.push(
      `requestedNodeHeapMb (${hints.requestedNodeHeapMb}) plus ${MEMORY_SAFETY_MARGIN_MB} MB safety margin exceeds host totalMemoryMb (${host.totalMemoryMb})`,
    );
  }

  if (!hostInspectable && explicitHintsPresent) {
    reasons.push("host resource inspection failed while explicit resource hints were present");
  }

  const unknownRunner = hasUnknownRunnerLabel(hints);
  if (unknownRunner && hostInspectable) {
    reasons.push(
      `unknown runner label(s) [${hints.labels.join(", ")}] - assuming local host capacity (${host.cpuCount} CPU, ${Math.round(host.totalMemoryMb)} MB)`,
    );
  }

  if (reasons.length === 0) {
    return {
      fidelity: "faithful",
      summary: "host resources satisfy declared job hints",
      reasons: [],
      action: "No action needed.",
    };
  }

  return {
    fidelity: "degraded",
    summary: "job resource hints exceed the available host capacity",
    reasons,
    action: buildAction(host.dockerHost),
  };
}
