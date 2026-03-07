import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── ensureWorldWritable ───────────────────────────────────────────────────────

describe("ensureWorldWritable", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dirsetup-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sets all directories to 0o777", async () => {
    const { ensureWorldWritable } = await import("./directory-setup.js");
    const dir1 = path.join(tmpDir, "a");
    const dir2 = path.join(tmpDir, "b");
    fs.mkdirSync(dir1);
    fs.mkdirSync(dir2);

    // Start with restrictive permissions
    fs.chmodSync(dir1, 0o700);
    fs.chmodSync(dir2, 0o700);

    ensureWorldWritable([dir1, dir2]);

    expect(fs.statSync(dir1).mode & 0o777).toBe(0o777);
    expect(fs.statSync(dir2).mode & 0o777).toBe(0o777);
  });

  it("does not throw on non-existent directories", async () => {
    const { ensureWorldWritable } = await import("./directory-setup.js");
    expect(() => ensureWorldWritable(["/nonexistent/path"])).not.toThrow();
  });
});
