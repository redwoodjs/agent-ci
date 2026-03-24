import { describe, it, expect } from "vitest";
import { computeDockerCpuPercent, extractMemoryStats } from "./docker-stats.js";

describe("computeDockerCpuPercent", () => {
  it("returns 0 when no delta", () => {
    const stats = {
      cpu_stats: {
        cpu_usage: { total_usage: 100 },
        system_cpu_usage: 1000,
      },
      precpu_stats: {
        cpu_usage: { total_usage: 100 },
        system_cpu_usage: 1000,
      },
      memory_stats: { usage: 0, limit: 1 },
    };
    expect(computeDockerCpuPercent(stats)).toBe(0);
  });

  it("calculates CPU percentage correctly", () => {
    const stats = {
      cpu_stats: {
        cpu_usage: { total_usage: 200 },
        system_cpu_usage: 2000,
      },
      precpu_stats: {
        cpu_usage: { total_usage: 100 },
        system_cpu_usage: 1000,
      },
      memory_stats: { usage: 0, limit: 1 },
    };
    // (200-100)/(2000-1000)*100 = 10%
    expect(computeDockerCpuPercent(stats)).toBe(10);
  });

  it("returns 0 when previous CPU sample is missing", () => {
    const stats = {
      cpu_stats: {
        cpu_usage: { total_usage: 100 },
        system_cpu_usage: 1000,
      },
      memory_stats: { usage: 0, limit: 1 },
    };
    expect(computeDockerCpuPercent(stats)).toBe(0);
  });
});

describe("extractMemoryStats", () => {
  it("extracts memory usage and calculates percentage", () => {
    const stats = {
      cpu_stats: {
        cpu_usage: { total_usage: 0 },
        system_cpu_usage: 0,
      },
      precpu_stats: {
        cpu_usage: { total_usage: 0 },
        system_cpu_usage: 0,
      },
      memory_stats: {
        usage: 512 * 1024 * 1024, // 512MB
        limit: 1024 * 1024 * 1024, // 1GB
      },
    };
    const result = extractMemoryStats(stats);
    expect(result.usageBytes).toBe(512 * 1024 * 1024);
    expect(result.limitBytes).toBe(1024 * 1024 * 1024);
    expect(result.percent).toBe(50);
  });

  it("handles missing memory_stats", () => {
    const stats = {
      cpu_stats: {
        cpu_usage: { total_usage: 0 },
        system_cpu_usage: 0,
      },
      precpu_stats: {
        cpu_usage: { total_usage: 0 },
        system_cpu_usage: 0,
      },
    };
    const result = extractMemoryStats(stats);
    expect(result.usageBytes).toBe(0);
    expect(result.limitBytes).toBe(1);
    expect(result.percent).toBe(0);
  });

  it("returns 0% when limit is 0", () => {
    const stats = {
      cpu_stats: {
        cpu_usage: { total_usage: 0 },
        system_cpu_usage: 0,
      },
      precpu_stats: {
        cpu_usage: { total_usage: 0 },
        system_cpu_usage: 0,
      },
      memory_stats: {
        usage: 100,
        limit: 0,
      },
    };
    const result = extractMemoryStats(stats);
    expect(result.percent).toBe(0);
  });
});
