import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderRunState } from "./state-renderer.js";
import type { RunState } from "./run-state.js";

// Freeze time so spinner frames and elapsed times are deterministic.
// Date.now() → 0 → Math.floor(0/80) % 10 → frame index 0 → "⠋"
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: "test-run",
    status: "running",
    startedAt: "1970-01-01T00:00:00.000Z",
    workflows: [],
    ...overrides,
  };
}

describe("renderRunState", () => {
  describe("single workflow, single job", () => {
    it("renders boot spinner before timeline appears", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            jobs: [
              {
                id: "test",
                runnerId: "agent-ci-5",
                status: "booting",
                startedAt: "1970-01-01T00:00:00.000Z",
                steps: [],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("ci.yml");
      expect(output).toContain("⠋");
      expect(output).toContain("Starting runner agent-ci-5 (0s)");
    });

    it("renders starting-runner node alongside steps once running", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            jobs: [
              {
                id: "test",
                runnerId: "agent-ci-5",
                status: "running",
                startedAt: "1970-01-01T00:00:00.000Z",
                bootDurationMs: 2300,
                steps: [
                  { name: "Set up job", index: 1, status: "completed", durationMs: 1000 },
                  {
                    name: "Run pnpm check",
                    index: 2,
                    status: "running",
                    startedAt: "1970-01-01T00:00:00.000Z",
                  },
                ],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("ci.yml");
      expect(output).toContain("Starting runner agent-ci-5 (2.3s)");
      expect(output).toContain("test");
      expect(output).toContain("✓ 1. Set up job (1s)");
      expect(output).toContain("⠋ 2. Run pnpm check (0s...)");
    });

    it("renders completed steps with tick icons", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "completed",
            jobs: [
              {
                id: "test",
                runnerId: "agent-ci-5",
                status: "completed",
                bootDurationMs: 2000,
                steps: [
                  { name: "Set up job", index: 1, status: "completed", durationMs: 1000 },
                  { name: "Run tests", index: 2, status: "completed", durationMs: 10000 },
                  { name: "Complete job", index: 3, status: "completed", durationMs: 200 },
                ],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("✓ 1. Set up job (1s)");
      expect(output).toContain("✓ 2. Run tests (10s)");
      expect(output).toContain("✓ 3. Complete job (0s)");
    });

    it("renders a failed step with ✗ icon", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "failed",
            jobs: [
              {
                id: "test",
                runnerId: "agent-ci-5",
                status: "failed",
                failedStep: "Run tests",
                bootDurationMs: 1000,
                steps: [
                  { name: "Set up job", index: 1, status: "completed", durationMs: 500 },
                  { name: "Run tests", index: 2, status: "failed", durationMs: 5000 },
                ],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("✓ 1. Set up job (1s)");
      expect(output).toContain("✗ 2. Run tests (5s)");
    });

    it("renders a skipped step with ⊘ icon", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "completed",
            jobs: [
              {
                id: "test",
                runnerId: "agent-ci-5",
                status: "completed",
                bootDurationMs: 1000,
                steps: [
                  { name: "Run tests", index: 1, status: "skipped" },
                  { name: "Complete job", index: 2, status: "completed", durationMs: 100 },
                ],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("⊘ 1. Run tests");
    });

    it("renders a pending step with ○ icon", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            jobs: [
              {
                id: "test",
                runnerId: "agent-ci-5",
                status: "running",
                bootDurationMs: 1000,
                steps: [
                  { name: "Set up job", index: 1, status: "completed", durationMs: 500 },
                  { name: "Run tests", index: 2, status: "pending" },
                ],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("○ 2. Run tests");
    });

    it("renders paused step with frozen timer and retry hints", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            jobs: [
              {
                id: "test",
                runnerId: "agent-ci-5",
                status: "paused",
                bootDurationMs: 1000,
                pausedAtStep: "Run tests",
                pausedAtMs: "1970-01-01T00:00:05.000Z", // 5s after epoch
                attempt: 1,
                lastOutputLines: ["Error: assertion failed"],
                steps: [
                  { name: "Set up job", index: 1, status: "completed", durationMs: 500 },
                  {
                    name: "Run tests",
                    index: 2,
                    status: "paused",
                    startedAt: "1970-01-01T00:00:03.000Z", // 3s after epoch
                  },
                ],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      // Paused step icon
      expect(output).toContain("⏸ 2. Run tests (2s)"); // 5s - 3s = 2s frozen
      // Retry attempt indicator
      expect(output).toContain("Step failed attempt #1");
      // Trailing retry/abort hints (single-job mode)
      expect(output).toContain("↻ To retry:");
      expect(output).toContain("agent-ci retry --runner agent-ci-5");
      expect(output).toContain("■ To abort:");
      expect(output).toContain("agent-ci abort --runner agent-ci-5");
      // Last output lines
      expect(output).toContain("Last output:");
      expect(output).toContain("Error: assertion failed");
    });

    it("renders retrying step with 'retrying' label", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            jobs: [
              {
                id: "test",
                runnerId: "agent-ci-5",
                status: "running",
                bootDurationMs: 1000,
                pausedAtStep: "Run tests", // was paused on this step
                attempt: 1, // has been retried
                steps: [
                  { name: "Set up job", index: 1, status: "completed", durationMs: 500 },
                  {
                    name: "Run tests",
                    index: 2,
                    status: "running",
                    startedAt: "1970-01-01T00:00:00.000Z",
                  },
                ],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("retrying");
      expect(output).toContain("Run tests");
    });
  });

  describe("multi-job workflow", () => {
    it("collapses completed jobs to a single summary line", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            jobs: [
              {
                id: "lint",
                runnerId: "agent-ci-5-j1",
                status: "completed",
                durationMs: 5000,
                steps: [],
              },
              {
                id: "test",
                runnerId: "agent-ci-5-j2",
                status: "running",
                bootDurationMs: 1000,
                steps: [
                  {
                    name: "Run tests",
                    index: 1,
                    status: "running",
                    startedAt: "1970-01-01T00:00:00.000Z",
                  },
                ],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      // Completed job collapsed (includes runner name)
      expect(output).toContain("✓ lint");
      expect(output).toContain("agent-ci-5-j1");
      // Running job shows steps
      expect(output).toContain("test");
      expect(output).toContain("agent-ci-5-j2");
      expect(output).toContain("⠋ 1. Run tests (0s...)");
      // Does NOT show "Starting runner" for the running job in multi-job mode
      expect(output).not.toContain("Starting runner agent-ci-5-j2 (");
    });

    it("shows ✗ icon for failed completed job", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "failed",
            jobs: [
              {
                id: "lint",
                runnerId: "agent-ci-5-j1",
                status: "failed",
                failedStep: "Run lint",
                durationMs: 3000,
                steps: [],
              },
              {
                id: "test",
                runnerId: "agent-ci-5-j2",
                status: "completed",
                durationMs: 5000,
                steps: [],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("✗ lint");
      expect(output).toContain("agent-ci-5-j1");
    });

    it("shows retry hint as child node in multi-job paused mode", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            jobs: [
              {
                id: "lint",
                runnerId: "agent-ci-5-j1",
                status: "completed",
                durationMs: 5000,
                steps: [],
              },
              {
                id: "test",
                runnerId: "agent-ci-5-j2",
                status: "paused",
                pausedAtStep: "Run tests",
                pausedAtMs: "1970-01-01T00:00:05.000Z",
                attempt: 1,
                bootDurationMs: 1000,
                steps: [
                  {
                    name: "Run tests",
                    index: 1,
                    status: "paused",
                    startedAt: "1970-01-01T00:00:03.000Z",
                  },
                ],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      // Retry hint is a child node in the tree
      expect(output).toContain("↻ retry: agent-ci retry --runner agent-ci-5-j2");
      // Trailing "To retry:" / "To abort:" lines also shown in multi-job mode
      expect(output).toContain("↻ To retry:");
      expect(output).toContain("■ To abort:");
    });

    it("shows last output lines for paused job in multi-job mode", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            jobs: [
              {
                id: "build",
                runnerId: "agent-ci-5-j1",
                status: "completed",
                durationMs: 5000,
                steps: [],
              },
              {
                id: "test",
                runnerId: "agent-ci-5-j2",
                status: "paused",
                pausedAtStep: "Run tests",
                pausedAtMs: "1970-01-01T00:00:05.000Z",
                attempt: 1,
                lastOutputLines: ["FAIL src/app.test.ts", "  Expected: true", "  Received: false"],
                bootDurationMs: 1000,
                steps: [
                  {
                    name: "Run tests",
                    index: 1,
                    status: "paused",
                    startedAt: "1970-01-01T00:00:03.000Z",
                  },
                ],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("Last output:");
      expect(output).toContain("FAIL src/app.test.ts");
      expect(output).toContain("Expected: true");
      expect(output).toContain("Received: false");
    });
  });

  describe("multi-workflow (--all mode)", () => {
    it("renders multiple workflow roots", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "completed",
            jobs: [
              {
                id: "test",
                runnerId: "agent-ci-5-j1",
                status: "completed",
                durationMs: 15000,
                steps: [],
              },
            ],
          },
          {
            id: "deploy.yml",
            path: "/repo/.github/workflows/deploy.yml",
            status: "running",
            jobs: [
              {
                id: "deploy",
                runnerId: "agent-ci-5-j2",
                status: "booting",
                startedAt: "1970-01-01T00:00:00.000Z",
                steps: [],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("ci.yml");
      expect(output).toContain("deploy.yml");
      expect(output).toContain("✓ test");
      expect(output).toContain("agent-ci-5-j1");
      expect(output).toContain("⠋ Starting runner agent-ci-5-j2 (0s)");
    });

    it("groups multiple jobs under their respective workflow", () => {
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "completed",
            jobs: [
              {
                id: "lint",
                runnerId: "agent-ci-5-j1",
                status: "completed",
                durationMs: 5000,
                steps: [],
              },
              {
                id: "test",
                runnerId: "agent-ci-5-j2",
                status: "completed",
                durationMs: 10000,
                steps: [],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      // ci.yml appears exactly once as root
      expect(output.split("ci.yml").length).toBe(2); // 1 occurrence → 2 parts
      expect(output).toContain("✓ lint");
      expect(output).toContain("agent-ci-5-j1");
      expect(output).toContain("✓ test");
      expect(output).toContain("agent-ci-5-j2");
    });
  });

  describe("boot spinner in booting phase", () => {
    it("shows elapsed boot time in seconds", () => {
      // Boot started 7 seconds ago in wall clock time
      vi.setSystemTime(7000);
      const state = makeState({
        workflows: [
          {
            id: "ci.yml",
            path: "/repo/.github/workflows/ci.yml",
            status: "running",
            jobs: [
              {
                id: "test",
                runnerId: "agent-ci-5",
                status: "booting",
                startedAt: "1970-01-01T00:00:00.000Z", // epoch
                steps: [],
              },
            ],
          },
        ],
      });

      const output = renderRunState(state);
      expect(output).toContain("Starting runner agent-ci-5 (7s)");
    });
  });
});
