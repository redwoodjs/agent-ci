/**
 * Docker stats utilities for monitoring container resource usage.
 */

interface DockerStats {
  cpu_stats: {
    cpu_usage: {
      total_usage: number;
    };
    system_cpu_usage: number;
  };
  precpu_stats?: {
    cpu_usage: {
      total_usage: number;
    };
    system_cpu_usage: number;
  };
  memory_stats?: {
    usage: number;
    limit: number;
  };
}

interface MemoryStats {
  usageBytes: number;
  limitBytes: number;
  percent: number;
}

/**
 * Calculate CPU percentage from Docker stats.
 * Returns percentage of host CPU being used (can exceed 100% for multi-core).
 */
export function computeDockerCpuPercent(stats: DockerStats): number {
  const prevCpuUsage = stats.precpu_stats?.cpu_usage.total_usage;
  const prevSystemUsage = stats.precpu_stats?.system_cpu_usage;

  if (prevCpuUsage == null || prevSystemUsage == null || prevSystemUsage <= 0 || prevCpuUsage < 0) {
    return 0;
  }

  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - prevCpuUsage;
  const systemDelta = stats.cpu_stats.system_cpu_usage - prevSystemUsage;

  if (systemDelta > 0 && cpuDelta > 0) {
    return (cpuDelta / systemDelta) * 100;
  }
  return 0;
}

/**
 * Extract memory stats from Docker stats.
 */
export function extractMemoryStats(stats: DockerStats): MemoryStats {
  const usageBytes = stats.memory_stats?.usage ?? 0;
  const limitBytes = stats.memory_stats?.limit ?? 1;
  const percent = limitBytes > 0 ? (usageBytes / limitBytes) * 100 : 0;

  return {
    usageBytes,
    limitBytes,
    percent,
  };
}
