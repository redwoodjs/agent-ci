import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock log-update AND tree-renderer before importing
vi.mock("log-update", () => {
  const fn: any = vi.fn();
  fn.done = vi.fn();
  return { default: fn };
});

import logUpdate from "log-update";
import { RenderContext } from "./render-context.js";

describe("RenderContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a single workflow with one job", () => {
    const ctx = new RenderContext();
    ctx.updateJob("tests.yml", "runner-1", { label: "✓ test (5s)" });
    ctx.flush();
    // renderTree will be called with a root node "tests.yml" containing one child
    const output = (logUpdate as any).mock.calls[0][0] as string;
    expect(output).toContain("tests.yml");
    expect(output).toContain("✓ test (5s)");
  });

  it("groups multiple jobs under the same workflow", () => {
    const ctx = new RenderContext();
    ctx.updateJob("ci.yml", "runner-1", { label: "✓ lint (5s)" });
    ctx.updateJob("ci.yml", "runner-2", { label: "✓ test (10s)" });
    ctx.flush();
    const output = (logUpdate as any).mock.calls[0][0] as string;
    // Both jobs should be under ci.yml
    expect(output).toContain("ci.yml");
    expect(output).toContain("✓ lint (5s)");
    expect(output).toContain("✓ test (10s)");
    // ci.yml should appear only once
    expect(output.split("ci.yml").length).toBe(2); // 1 occurrence → 2 parts
  });

  it("renders multiple workflows as separate root nodes", () => {
    const ctx = new RenderContext();
    ctx.updateJob("tests.yml", "runner-1", { label: "✓ test (5s)" });
    ctx.updateJob("ci.yml", "runner-2", { label: "⠹ lint (3s...)" });
    ctx.flush();
    const output = (logUpdate as any).mock.calls[0][0] as string;
    expect(output).toContain("tests.yml");
    expect(output).toContain("ci.yml");
    expect(output).toContain("✓ test (5s)");
    expect(output).toContain("⠹ lint (3s...)");
  });

  it("updates a job in place", () => {
    const ctx = new RenderContext();
    ctx.updateJob("tests.yml", "runner-1", { label: "⠹ test (3s...)" });
    ctx.updateJob("tests.yml", "runner-1", { label: "✓ test (5s)" });
    ctx.flush();
    const output = (logUpdate as any).mock.calls[0][0] as string;
    expect(output).toContain("✓ test (5s)");
    expect(output).not.toContain("⠹ test (3s...)");
  });

  it("calls logUpdate.done() on done()", () => {
    const ctx = new RenderContext();
    ctx.done();
    expect((logUpdate as any).done).toHaveBeenCalled();
  });
});
