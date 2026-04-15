import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Polka } from "polka";
import { state, getActionTarballsDir } from "../../store.js";
import { bootstrapAndReturnApp } from "../../index.js";
import { rewriteSetupNodeTarball } from "./index.js";

const HARDCODED_URL = "`https://api.github.com/repos/";
const REWRITTEN_URL_FRAGMENT = "process.env.GITHUB_API_URL";

function buildFakeSetupNodeTarball(destGzPath: string): void {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dtu-fake-setup-node-"));
  try {
    const rootEntry = "actions-setup-node-deadbeef";
    const setupDir = path.join(workRoot, rootEntry, "dist", "setup");
    fs.mkdirSync(setupDir, { recursive: true });
    fs.writeFileSync(
      path.join(setupDir, "index.js"),
      // Mirror the real dist — same template-literal shape that tool-cache emits.
      `const treeUrl = ${HARDCODED_URL}\${owner}/\${repo}/git/trees/\${branch}\`;\n`,
    );
    // Include a second file so we verify the rewrite leaves unrelated files alone.
    fs.writeFileSync(path.join(workRoot, rootEntry, "README.md"), "# fake setup-node\n");
    execSync(
      `tar -czf ${JSON.stringify(destGzPath)} -C ${JSON.stringify(workRoot)} ${JSON.stringify(rootEntry)}`,
    );
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

describe("rewriteSetupNodeTarball", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtu-setup-node-rewrite-test-"));
  });

  it("rewrites the hardcoded api.github.com URL in dist/setup/index.js", () => {
    const srcGz = path.join(workDir, "src.tar.gz");
    const destGz = path.join(workDir, "dest.tar.gz");
    buildFakeSetupNodeTarball(srcGz);

    rewriteSetupNodeTarball(srcGz, destGz);

    const extractDir = path.join(workDir, "extracted");
    fs.mkdirSync(extractDir);
    execSync(`tar -xzf ${JSON.stringify(destGz)} -C ${JSON.stringify(extractDir)}`);
    const [rootEntry] = fs.readdirSync(extractDir);
    const rewrittenSrc = fs.readFileSync(
      path.join(extractDir, rootEntry, "dist", "setup", "index.js"),
      "utf-8",
    );
    expect(rewrittenSrc).not.toContain(HARDCODED_URL);
    expect(rewrittenSrc).toContain(REWRITTEN_URL_FRAGMENT);
    // Untouched files survive the round-trip.
    expect(fs.existsSync(path.join(extractDir, rootEntry, "README.md"))).toBe(true);
  });

  it("is a no-op for tarballs without the hardcoded URL (still produces a valid tarball)", () => {
    const srcGz = path.join(workDir, "src.tar.gz");
    const destGz = path.join(workDir, "dest.tar.gz");
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dtu-noop-"));
    try {
      const rootEntry = "actions-setup-node-noop";
      const setupDir = path.join(workRoot, rootEntry, "dist", "setup");
      fs.mkdirSync(setupDir, { recursive: true });
      fs.writeFileSync(path.join(setupDir, "index.js"), "// no URL here\n");
      execSync(
        `tar -czf ${JSON.stringify(srcGz)} -C ${JSON.stringify(workRoot)} ${JSON.stringify(rootEntry)}`,
      );
    } finally {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }

    expect(() => rewriteSetupNodeTarball(srcGz, destGz)).not.toThrow();
    expect(fs.existsSync(destGz)).toBe(true);
  });
});

let PORT: number;

describe("DTU manifest-proxy routes (setup-node mock)", () => {
  let server: Polka;

  const apiProxyDir = () => path.join(getActionTarballsDir(), "..", "api-github-proxy");

  beforeAll(async () => {
    state.reset();
    const app = await bootstrapAndReturnApp();
    return new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.server?.address() as AddressInfo;
        PORT = address.port;
        resolve();
      });
    });
  });

  beforeEach(() => {
    state.reset();
    fs.rmSync(apiProxyDir(), { recursive: true, force: true });
  });

  afterAll(async () => {
    fs.rmSync(apiProxyDir(), { recursive: true, force: true });
    await new Promise<void>((resolve) => {
      if (server?.server) {
        server.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  });

  it("serves cached tree responses with blob URLs rewritten to the DTU base", async () => {
    const baseUrl = `http://localhost:${PORT}`;
    // Pre-seed the cache with an upstream-shaped payload so no network is hit.
    const cacheDir = apiProxyDir();
    fs.mkdirSync(cacheDir, { recursive: true });
    const cached = {
      sha: "treesha",
      tree: [
        {
          path: "versions-manifest.json",
          sha: "blobsha1",
          url: "https://api.github.com/repos/actions/node-versions/git/blobs/blobsha1",
        },
        { path: "README.md", sha: "blobsha2", url: "https://api.github.com/other" },
      ],
    };
    fs.writeFileSync(
      path.join(cacheDir, "tree__actions__node-versions__main.json"),
      JSON.stringify(cached),
    );

    const res = await fetch(`${baseUrl}/repos/actions/node-versions/git/trees/main`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Blob URLs in the response should point back at this DTU instance.
    expect(body.tree[0].url).toBe(`${baseUrl}/repos/actions/node-versions/git/blobs/blobsha1`);
    expect(body.tree[1].url).toBe(`${baseUrl}/repos/actions/node-versions/git/blobs/blobsha2`);
  });

  it("serves cached blob responses by (sha, accept) tuple", async () => {
    const baseUrl = `http://localhost:${PORT}`;
    const cacheDir = apiProxyDir();
    fs.mkdirSync(cacheDir, { recursive: true });
    const rawManifest = '[{"version":"24.14.1","stable":true}]';
    fs.writeFileSync(
      path.join(cacheDir, "blob__actions__node-versions__blobsha1__raw.json"),
      JSON.stringify({
        contentType: "application/json; charset=utf-8",
        bodyB64: Buffer.from(rawManifest).toString("base64"),
      }),
    );

    const res = await fetch(`${baseUrl}/repos/actions/node-versions/git/blobs/blobsha1`, {
      headers: { Accept: "application/vnd.github.VERSION.raw" },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe(rawManifest);
  });

  it("does not confuse raw and json blob variants (cache-keyed separately)", async () => {
    const baseUrl = `http://localhost:${PORT}`;
    const cacheDir = apiProxyDir();
    fs.mkdirSync(cacheDir, { recursive: true });
    // Only the `json` variant is cached. A `raw` request must miss (not serve
    // the json payload) — if GitHub is unreachable in test env, that's fine;
    // we only need to verify it didn't return the wrong-variant cached body.
    const jsonPayload = '{"encoding":"base64","content":"aGk="}';
    fs.writeFileSync(
      path.join(cacheDir, "blob__actions__node-versions__sha__json.json"),
      JSON.stringify({
        contentType: "application/json",
        bodyB64: Buffer.from(jsonPayload).toString("base64"),
      }),
    );

    const rawRes = await fetch(`${baseUrl}/repos/actions/node-versions/git/blobs/sha`, {
      headers: { Accept: "application/vnd.github.VERSION.raw" },
    });
    // Either it miss-fetches upstream (any status ≥ 200) or 502s — but it must
    // never return the json-variant body.
    const rawBody = await rawRes.text();
    expect(rawBody).not.toBe(jsonPayload);
  });
});
