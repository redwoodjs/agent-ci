import { describe, it, expect } from "vitest";
import { collapseMatrixToSingle, expandMatrixCombinations } from "./workflow-parser.js";

// ─── collapseMatrixToSingle ───────────────────────────────────────────────────
//
// These tests cover the --no-matrix flag behavior: when the flag is active,
// all matrix combinations are collapsed into a single job that carries the
// first value of each matrix key plus __job_total="1" and __job_index="0".
//
// The Developer must export `collapseMatrixToSingle` from workflow-parser.ts
// with the signature:
//   collapseMatrixToSingle(matrixDef: Record<string, any[]>): Record<string, string>[]

describe("collapseMatrixToSingle", () => {
  // ── Core collapse behavior ──────────────────────────────────────────────────

  it("returns exactly one job regardless of how many matrix values exist", () => {
    const result = collapseMatrixToSingle({
      shard: ["1", "2", "3", "4", "5", "6", "7", "8"],
    });
    expect(result).toHaveLength(1);
  });

  it("uses the first value of a single-key matrix", () => {
    const result = collapseMatrixToSingle({
      shard: ["1", "2", "3", "4", "5", "6", "7", "8"],
    });
    expect(result[0].shard).toBe("1");
  });

  it("sets __job_total to '1' on the collapsed job", () => {
    const result = collapseMatrixToSingle({ shard: ["1", "2", "3"] });
    expect(result[0].__job_total).toBe("1");
  });

  it("sets __job_index to '0' on the collapsed job", () => {
    const result = collapseMatrixToSingle({ shard: ["1", "2", "3"] });
    expect(result[0].__job_index).toBe("0");
  });

  // ── Multi-key matrix ────────────────────────────────────────────────────────

  it("collapses a multi-key matrix: all keys present, each set to its first value", () => {
    const result = collapseMatrixToSingle({
      browser: ["chrome", "firefox", "safari"],
      shard: ["1", "2", "3", "4"],
    });
    expect(result).toHaveLength(1);
    expect(result[0].browser).toBe("chrome");
    expect(result[0].shard).toBe("1");
  });

  it("sets __job_total and __job_index to '1'/'0' regardless of combination count across multiple keys", () => {
    // 3 × 3 = 9 combinations without collapse; must still produce one job
    const result = collapseMatrixToSingle({
      os: ["ubuntu", "macos", "windows"],
      node: ["18", "20", "22"],
    });
    expect(result).toHaveLength(1);
    expect(result[0].__job_total).toBe("1");
    expect(result[0].__job_index).toBe("0");
  });

  // ── Degenerate / edge cases ─────────────────────────────────────────────────

  it("handles a matrix that already has exactly one combination (degenerate case)", () => {
    const result = collapseMatrixToSingle({ shard: ["1"] });
    expect(result).toHaveLength(1);
    expect(result[0].shard).toBe("1");
    expect(result[0].__job_total).toBe("1");
    expect(result[0].__job_index).toBe("0");
  });

  it("does not throw when a matrix key has an empty value list", () => {
    expect(() => collapseMatrixToSingle({ shard: [] })).not.toThrow();
  });

  it("coerces numeric matrix values to strings", () => {
    // Matrix values in YAML may be parsed as numbers (e.g. shard: [1, 2, 3])
    const result = collapseMatrixToSingle({ shard: [1, 2, 3] as any });
    expect(result[0].shard).toBe("1");
  });
});

// ─── Default expansion unaffected when --no-matrix is absent ─────────────────
//
// Without --no-matrix, the normal `expandMatrixCombinations` path must continue
// to produce one job per combination. These tests guard against regressions.

describe("expandMatrixCombinations (default path, no --no-matrix)", () => {
  it("expands a single-key matrix into one job per value", () => {
    const result = expandMatrixCombinations({ shard: ["1", "2", "3"] });
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.shard)).toEqual(["1", "2", "3"]);
  });

  it("expands a multi-key matrix into the full cartesian product", () => {
    const result = expandMatrixCombinations({
      browser: ["chrome", "firefox"],
      shard: ["1", "2"],
    });
    // 2 × 2 = 4 combinations
    expect(result).toHaveLength(4);
  });

  it("does not include __job_total or __job_index in expanded jobs", () => {
    const result = expandMatrixCombinations({ shard: ["1", "2"] });
    for (const job of result) {
      expect(job).not.toHaveProperty("__job_total");
      expect(job).not.toHaveProperty("__job_index");
    }
  });
});
