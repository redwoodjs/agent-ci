import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveMachinenImage } from "./image-mapping.ts";
import { __test_resetInFlight, OVERRIDE_PATH_FRAGMENT } from "./rootfs.ts";

const fetcher: typeof fetch = (async () =>
  ({
    status: 200,
    statusText: "OK",
    ok: true,
    body: Readable.from([Buffer.from("default-base")]) as unknown as ReadableStream<Uint8Array>,
    headers: { get: () => null } as Response["headers"],
  }) as unknown as Response) as typeof fetch;

describe("resolveMachinenImage", () => {
  let repoRoot: string;
  let cacheRoot: string;
  beforeEach(async () => {
    __test_resetInFlight();
    repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "image-repo-"));
    cacheRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "image-cache-"));
  });
  afterEach(async () => {
    await fsp.rm(repoRoot, { recursive: true, force: true });
    await fsp.rm(cacheRoot, { recursive: true, force: true });
  });

  it("picks up .github/agent-ci.machinen.tar.gz when present", async () => {
    const override = path.join(repoRoot, OVERRIDE_PATH_FRAGMENT);
    await fsp.mkdir(path.dirname(override), { recursive: true });
    await fsp.writeFile(override, "user-rootfs");
    const img = await resolveMachinenImage({ repoRoot, cacheRoot, fetcher });
    expect(img.source).toBe("override");
    expect(img.rootfsPath).toBe(override);
  });

  it("downloads when no override is present", async () => {
    const img = await resolveMachinenImage({
      repoRoot,
      cacheRoot,
      url: "https://example.test/rootfs.tar.gz",
      fetcher,
    });
    expect(img.source).toBe("downloaded");
    expect(fs.existsSync(img.rootfsPath)).toBe(true);
  });
});
