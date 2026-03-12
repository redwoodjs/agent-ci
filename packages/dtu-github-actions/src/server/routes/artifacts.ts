import { Polka } from "polka";
import fs from "node:fs";
import path from "node:path";
import { state } from "../store.js";
import { getBaseUrl } from "./dtu.js";
import { config } from "../../config.js";

const ARTIFACT_DIR = path.join(config.DTU_CACHE_DIR, "artifacts");
if (!fs.existsSync(ARTIFACT_DIR)) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

const TWIRP_PREFIX = "/twirp/github.actions.results.api.v1.ArtifactService";

export function registerArtifactRoutes(app: Polka) {
  // ── Twirp endpoints (used by actions/upload-artifact@v4 & actions/download-artifact@v4) ──

  // CreateArtifact — returns a signed upload URL
  app.post(`${TWIRP_PREFIX}/CreateArtifact`, (req: any, res) => {
    const { name, version } = req.body || {};
    if (!name) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ msg: "Missing artifact name" }));
    }

    const containerId = Math.floor(Math.random() * 1000000);
    const baseUrl = getBaseUrl(req);

    state.pendingArtifacts.set(containerId, { name, files: new Map() });

    console.log(`[DTU] CreateArtifact "${name}" (v${version}) → container ${containerId}`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        signedUploadUrl: `${baseUrl}/_apis/artifactblob/${containerId}/upload`,
      }),
    );
  });

  // FinalizeArtifact — mark upload as complete
  app.post(`${TWIRP_PREFIX}/FinalizeArtifact`, (req: any, res) => {
    const { name } = req.body || {};
    if (!name) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ msg: "Missing artifact name" }));
    }

    let foundId: number | null = null;
    for (const [id, pending] of state.pendingArtifacts) {
      if (pending.name === name) {
        foundId = id;
        break;
      }
    }

    if (foundId === null) {
      console.warn(`[DTU] FinalizeArtifact: not found "${name}"`);
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false }));
    }

    const pending = state.pendingArtifacts.get(foundId)!;
    state.artifacts.set(name, { containerId: foundId, files: new Map(pending.files) });
    state.pendingArtifacts.delete(foundId);

    console.log(`[DTU] FinalizeArtifact "${name}" (container ${foundId})`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, artifactId: String(foundId) }));
  });

  // ListArtifacts — find artifacts by name
  app.post(`${TWIRP_PREFIX}/ListArtifacts`, (req: any, res) => {
    const { nameFilter } = req.body || {};
    const filterName = typeof nameFilter === "string" ? nameFilter : nameFilter?.value;

    console.log(`[DTU] ListArtifacts (filter: ${filterName || "none"})`);

    const artifacts: any[] = [];
    for (const [name, art] of state.artifacts) {
      if (filterName && name !== filterName) {
        continue;
      }
      artifacts.push({
        workflowRunBackendId: "00000000-0000-0000-0000-000000000001",
        databaseId: String(art.containerId),
        name,
        size: String(art.files.size > 0 ? fs.statSync(Array.from(art.files.values())[0]).size : 0),
        createdAt: new Date().toISOString(),
      });
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ artifacts }));
  });

  // GetSignedArtifactURL — return a download URL for an artifact
  app.post(`${TWIRP_PREFIX}/GetSignedArtifactURL`, (req: any, res) => {
    const { name } = req.body || {};
    const baseUrl = getBaseUrl(req);

    const artifact = state.artifacts.get(name);
    if (!artifact) {
      console.warn(`[DTU] GetSignedArtifactURL: not found "${name}"`);
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ signedUrl: "" }));
    }

    console.log(`[DTU] GetSignedArtifactURL "${name}" → container ${artifact.containerId}`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        signedUrl: `${baseUrl}/_apis/artifactblob/${artifact.containerId}/download`,
      }),
    );
  });

  // ── Blob endpoints (signed URL targets) ──

  // Block storage for Azure block blob protocol
  // @actions/artifact v4 uses: PUT ?comp=block&blockid=X (upload block) then PUT ?comp=blocklist (commit)
  const blockStore = new Map<string, Map<string, Buffer>>(); // containerId → blockId → data

  // Upload blob (PUT from signed URL) — implements Azure Block Blob protocol
  app.put("/_apis/artifactblob/:containerId/upload", async (req: any, res) => {
    const containerId = req.params.containerId;
    const containerIdNum = parseInt(containerId, 10);
    const comp = req.query.comp;
    const blockId = req.query.blockid;
    const pending = state.pendingArtifacts.get(containerIdNum);

    if (!pending) {
      console.warn(`[DTU] Blob upload to invalid container: ${containerId}`);
      res.writeHead(404);
      return res.end();
    }

    // Collect body (may be streaming/chunked)
    let buffer: Buffer;
    try {
      if (Buffer.isBuffer(req.body)) {
        buffer = req.body;
      } else if (typeof req.body === "string") {
        buffer = Buffer.from(req.body);
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        buffer = Buffer.concat(chunks);
      }
    } catch (e) {
      console.error("[DTU] Failed to read blob upload body:", e);
      res.writeHead(500);
      return res.end();
    }

    if (comp === "block" && blockId) {
      // Stage a block
      if (!blockStore.has(containerId)) {
        blockStore.set(containerId, new Map());
      }
      blockStore.get(containerId)!.set(blockId, buffer);
      console.log(
        `[DTU] Staged block ${blockId} for container ${containerId} (${buffer.length} bytes)`,
      );
      res.writeHead(201);
      return res.end();
    }

    if (comp === "blocklist") {
      // Commit: assemble staged blocks in order from XML block list
      const blocks = blockStore.get(containerId) ?? new Map<string, Buffer>();
      const diskPath = path.join(ARTIFACT_DIR, `${containerId}_blob.zip`);

      // Parse blockid list from XML: <Latest>blockid</Latest> entries
      const xml = buffer.toString("utf8");
      const ids: string[] = [];
      for (const m of xml.matchAll(/<Latest>([^<]+)<\/Latest>/g)) {
        ids.push(m[1]);
      }

      const assembled =
        ids.length > 0
          ? Buffer.concat(ids.map((id) => blocks.get(id) ?? Buffer.alloc(0)))
          : Buffer.concat(Array.from(blocks.values())); // fallback: concat all in insertion order

      fs.writeFileSync(diskPath, assembled);
      blockStore.delete(containerId);
      pending.files.set("artifact.zip", diskPath);

      console.log(
        `[DTU] Committed block blob for container ${containerId} (${assembled.length} bytes, ${ids.length} blocks)`,
      );
      res.writeHead(201);
      return res.end();
    }

    // Single-block upload (no comp param) — write directly
    const diskPath = path.join(ARTIFACT_DIR, `${containerIdNum}_blob.zip`);
    fs.writeFileSync(diskPath, buffer);
    pending.files.set("artifact.zip", diskPath);
    console.log(`[DTU] Blob uploaded to container ${containerIdNum} (${buffer.length} bytes)`);
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  // Download blob (GET from signed URL)
  app.get("/_apis/artifactblob/:containerId/download", (req: any, res) => {
    const containerId = parseInt(req.params.containerId, 10);

    let found: { containerId: number; files: Map<string, string> } | null = null;
    for (const art of state.artifacts.values()) {
      if (art.containerId === containerId) {
        found = art;
        break;
      }
    }

    if (!found || found.files.size === 0) {
      console.warn(`[DTU] Blob download: container ${containerId} not found`);
      res.writeHead(404);
      return res.end();
    }

    const diskPath = Array.from(found.files.values())[0];
    if (!fs.existsSync(diskPath)) {
      console.warn(`[DTU] Blob download: file missing ${diskPath}`);
      res.writeHead(404);
      return res.end();
    }

    console.log(`[DTU] Blob download from container ${containerId}`);

    const stat = fs.statSync(diskPath);
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Length": stat.size,
    });
    fs.createReadStream(diskPath).pipe(res);
  });

  // ── Simple REST endpoints (used by curl-based smoke/e2e tests) ──

  // Create artifact container
  app.post("/_apis/artifacts", (req: any, res) => {
    const { name } = req.body || {};
    if (!name) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Missing artifact name" }));
    }

    const containerId = Math.floor(Math.random() * 1000000);
    const baseUrl = getBaseUrl(req);

    state.pendingArtifacts.set(containerId, { name, files: new Map() });

    console.log(`[DTU] Created artifact container ${containerId} for "${name}"`);

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        containerId,
        name,
        fileContainerResourceUrl: `${baseUrl}/_apis/artifacts/${containerId}`,
      }),
    );
  });

  // Upload file to artifact container
  app.put("/_apis/artifacts/:containerId", (req: any, res) => {
    const containerId = parseInt(req.params.containerId, 10);
    const itemPath = req.query.itemPath || "artifact.bin";
    const pending = state.pendingArtifacts.get(containerId);

    if (!pending) {
      console.warn(`[DTU] Artifact upload to invalid container: ${containerId}`);
      res.writeHead(404);
      return res.end();
    }

    console.log(`[DTU] Uploading artifact file "${itemPath}" to container ${containerId}`);

    const diskPath = path.join(ARTIFACT_DIR, `${containerId}_${path.basename(itemPath)}`);

    try {
      if (Buffer.isBuffer(req.body) || typeof req.body === "string") {
        const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
        fs.writeFileSync(diskPath, buffer);
      } else {
        res.writeHead(500, { "Content-Type": "text/plain" });
        return res.end("Expected raw buffer/string body");
      }

      pending.files.set(itemPath, diskPath);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      console.error("[DTU] Failed to write artifact file:", e);
      res.writeHead(500);
      res.end();
    }
  });

  // Finalize artifact
  app.patch("/_apis/artifacts", (req: any, res) => {
    const { artifactName } = req.body || {};

    if (!artifactName) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Missing artifactName" }));
    }

    let foundId: number | null = null;
    for (const [id, pending] of state.pendingArtifacts) {
      if (pending.name === artifactName) {
        foundId = id;
        break;
      }
    }

    if (foundId === null) {
      console.warn(`[DTU] Finalize artifact not found: "${artifactName}"`);
      res.writeHead(404);
      return res.end();
    }

    const pending = state.pendingArtifacts.get(foundId)!;
    state.artifacts.set(artifactName, {
      containerId: foundId,
      files: new Map(pending.files),
    });
    state.pendingArtifacts.delete(foundId);

    console.log(
      `[DTU] Finalized artifact "${artifactName}" (container ${foundId}, ${pending.files.size} file(s))`,
    );

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, containerId: foundId }));
  });

  // List / get artifact by name
  app.get("/_apis/artifacts", (req: any, res) => {
    const artifactName = req.query.artifactName;
    const baseUrl = getBaseUrl(req);

    if (artifactName) {
      const artifact = state.artifacts.get(artifactName);
      if (!artifact) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ count: 0, value: [] }));
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          count: 1,
          value: [
            {
              containerId: artifact.containerId,
              name: artifactName,
              fileContainerResourceUrl: `${baseUrl}/_apis/artifactfiles/${artifact.containerId}`,
            },
          ],
        }),
      );
    }

    const value = Array.from(state.artifacts.entries()).map(([name, art]) => ({
      containerId: art.containerId,
      name,
      fileContainerResourceUrl: `${baseUrl}/_apis/artifactfiles/${art.containerId}`,
    }));

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: value.length, value }));
  });

  // Download artifact file (REST)
  app.get("/_apis/artifactfiles/:containerId", (req: any, res) => {
    const containerId = parseInt(req.params.containerId, 10);

    let found: { containerId: number; files: Map<string, string> } | null = null;
    for (const art of state.artifacts.values()) {
      if (art.containerId === containerId) {
        found = art;
        break;
      }
    }

    if (!found || found.files.size === 0) {
      res.writeHead(404);
      return res.end();
    }

    const [, diskPath] = Array.from(found.files.entries())[0];
    if (!fs.existsSync(diskPath)) {
      res.writeHead(404);
      return res.end();
    }

    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": fs.statSync(diskPath).size,
    });
    fs.createReadStream(diskPath).pipe(res);
  });
}
