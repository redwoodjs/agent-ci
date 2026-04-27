import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DETACHED_ENV,
  DETACHED_MARKER_FILENAME,
  formatEvent,
  parseLogEvent,
  PAUSED_EXIT_CODE,
  readDetachedMarker,
  shouldLaunchDetached,
  writeDetachedMarker,
} from "./launcher.js";

describe("formatEvent / parseLogEvent — run.paused", () => {
  it("round-trips a paused event", () => {
    const event = {
      event: "run.paused" as const,
      runner: "agent-ci-1-job",
      step: "build",
      attempt: 2,
      workflow: "ci.yml",
      retry_cmd: "agent-ci retry --name agent-ci-1-job",
    };
    expect(parseLogEvent(formatEvent(event))).toEqual(event);
  });

  it("returns null for plain text log lines", () => {
    expect(parseLogEvent("hello world")).toBeNull();
    expect(parseLogEvent("")).toBeNull();
    expect(parseLogEvent("[Agent CI] Step failed: build")).toBeNull();
  });

  it("returns null for incidental JSON without an `event` discriminator", () => {
    expect(parseLogEvent(`{"foo":1}`)).toBeNull();
    expect(parseLogEvent(`{"event":"unknown"}`)).toBeNull();
  });

  it("returns null when JSON is malformed", () => {
    expect(parseLogEvent("{not-json")).toBeNull();
  });

  it("returns null for JSON arrays / primitives", () => {
    expect(parseLogEvent("[1,2,3]")).toBeNull();
    expect(parseLogEvent("null")).toBeNull();
    expect(parseLogEvent("42")).toBeNull();
  });

  it("matches whole-line objects only — no embedded matches", () => {
    expect(parseLogEvent(`prefix {"event":"run.paused"}`)).toBeNull();
  });
});

describe("formatEvent / parseLogEvent — run.completed", () => {
  it("round-trips a passed event", () => {
    expect(parseLogEvent(formatEvent({ event: "run.completed", status: "passed" }))).toEqual({
      event: "run.completed",
      status: "passed",
    });
  });

  it("round-trips a failed event", () => {
    expect(parseLogEvent(formatEvent({ event: "run.completed", status: "failed" }))).toEqual({
      event: "run.completed",
      status: "failed",
    });
  });
});

describe("shouldLaunchDetached", () => {
  const base = {
    pauseOnFailure: true,
    stdoutIsTTY: false,
    agentMode: false,
    alreadyWorker: false,
  };

  it("launches when pause-on-failure + non-TTY", () => {
    expect(shouldLaunchDetached(base)).toBe(true);
  });

  it("skips in agent mode — the harness tails live output across retry", () => {
    expect(shouldLaunchDetached({ ...base, agentMode: true })).toBe(false);
  });

  it("skips when --pause-on-failure is not set", () => {
    expect(shouldLaunchDetached({ ...base, pauseOnFailure: false })).toBe(false);
  });

  it("skips in interactive TTY mode", () => {
    expect(shouldLaunchDetached({ ...base, stdoutIsTTY: true })).toBe(false);
  });

  it("skips even when both TTY + agent-mode are set", () => {
    expect(shouldLaunchDetached({ ...base, stdoutIsTTY: true, agentMode: true })).toBe(false);
  });

  it("never re-launches inside the worker process", () => {
    expect(shouldLaunchDetached({ ...base, alreadyWorker: true })).toBe(false);
  });
});

describe("PAUSED_EXIT_CODE", () => {
  it("uses BSD EX_NOPERM (77) as the paused-but-not-failed code", () => {
    expect(PAUSED_EXIT_CODE).toBe(77);
  });
});

describe("writeDetachedMarker / readDetachedMarker", () => {
  let tmpDir: string;
  let originalDetached: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ci-launcher-test-"));
    originalDetached = process.env[DETACHED_ENV];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalDetached === undefined) {
      delete process.env[DETACHED_ENV];
    } else {
      process.env[DETACHED_ENV] = originalDetached;
    }
  });

  it("writes the marker when running detached", () => {
    process.env[DETACHED_ENV] = "/tmp/fake-worker.log";

    writeDetachedMarker(tmpDir);

    const marker = readDetachedMarker(tmpDir);
    expect(marker).not.toBeNull();
    expect(marker?.workerLogPath).toBe("/tmp/fake-worker.log");
    expect(marker?.workerPid).toBe(process.pid);
  });

  it("is a no-op when not running detached", () => {
    delete process.env[DETACHED_ENV];

    writeDetachedMarker(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, DETACHED_MARKER_FILENAME))).toBe(false);
    expect(readDetachedMarker(tmpDir)).toBeNull();
  });

  it("returns null when the marker file is missing or malformed", () => {
    expect(readDetachedMarker(tmpDir)).toBeNull();
    fs.writeFileSync(path.join(tmpDir, DETACHED_MARKER_FILENAME), "{not-json");
    expect(readDetachedMarker(tmpDir)).toBeNull();
    fs.writeFileSync(path.join(tmpDir, DETACHED_MARKER_FILENAME), JSON.stringify({ x: 1 }));
    expect(readDetachedMarker(tmpDir)).toBeNull();
  });
});
