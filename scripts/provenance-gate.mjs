import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import crypto from "node:crypto";

const DEFAULT_BASE_URL = "http://localhost:5173";
const BASE_URL = process.env.MACHINEN_BASE_URL ?? DEFAULT_BASE_URL;

function parsePortFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.port) {
      const p = Number.parseInt(u.port, 10);
      return Number.isFinite(p) ? p : null;
    }
    if (u.protocol === "http:") {
      return 80;
    }
    if (u.protocol === "https:") {
      return 443;
    }
  } catch {
    // ignore
  }
  return null;
}

function replacePort(url, port) {
  const u = new URL(url);
  u.port = String(port);
  return u.toString().replace(/\/$/, "");
}

function parseDevVarsValue(key) {
  try {
    const raw = fs.readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
    const line = raw
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith(`${key}=`));
    if (!line) {
      return null;
    }
    const v = line.slice(`${key}=`.length).trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

function parseWranglerVarsValue(key) {
  try {
    const raw = fs.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    const re = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`, "m");
    const m = raw.match(re);
    const v = m?.[1] ?? null;
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  } catch {
    return null;
  }
}

const API_KEY =
  process.env.MACHINEN_API_KEY ?? parseDevVarsValue("API_KEY") ?? "";
const MOMENT_GRAPH_NAMESPACE_PREFIX =
  process.env.MOMENT_GRAPH_NAMESPACE_PREFIX ??
  parseDevVarsValue("MOMENT_GRAPH_NAMESPACE_PREFIX") ??
  parseWranglerVarsValue("MOMENT_GRAPH_NAMESPACE_PREFIX") ??
  null;

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/__debug`, { method: "GET" });
      if (res.ok) {
        return true;
      }
    } catch {
      // ignore
    }
    await sleep(250);
  }
  return false;
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : null;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

function authHeaders() {
  if (!API_KEY) {
    throw new Error("Missing MACHINEN_API_KEY and could not read API_KEY from .dev.vars");
  }
  return { Authorization: `Bearer ${API_KEY}` };
}

async function postJson(baseUrl, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${path} failed: ${res.status} ${text}`);
  }
  return JSON.parse(text);
}

async function getJson(baseUrl, path) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: authHeaders(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status} ${text}`);
  }
  return JSON.parse(text);
}

function pickMomentIdFromDocumentAudit(logs) {
  if (!Array.isArray(logs)) {
    return null;
  }
  for (const log of logs) {
    const payload = log?.payload ?? null;
    const kind = typeof log?.kind === "string" ? log.kind : "";
    const candidates = [
      payload?.momentId,
      payload?.moment_id,
      payload?.id,
      payload?.moment?.id,
      payload?.moment?.momentId,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim().length > 0) {
        if (kind.includes("moment") || kind.includes("materialize")) {
          return c.trim();
        }
      }
    }
  }
  for (const log of logs) {
    const payload = log?.payload ?? null;
    const candidates = [payload?.momentId, payload?.moment_id, payload?.id, payload?.moment?.id];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim().length > 0) {
        return c.trim();
      }
    }
  }
  return null;
}

function summarizeProvenance(moment) {
  const m = moment ?? {};
  return {
    id: m.id ?? null,
    documentId: m.documentId ?? null,
    createdAt: m.createdAt ?? null,
    author: m.author ?? null,
    sourceMetadata: m.sourceMetadata ?? null,
  };
}

async function main() {
  const forceOwnDev = true;
  const alreadyUp = await waitForServer(BASE_URL, 250);

  const effectiveBaseUrl =
    forceOwnDev && alreadyUp ? replacePort(BASE_URL, await getFreePort()) : BASE_URL;

  let devProc = null;
  let startedDev = false;

  const shouldStartDev = forceOwnDev ? true : !alreadyUp;
  if (shouldStartDev) {
    const port = parsePortFromUrl(effectiveBaseUrl);
    const devArgs =
      port && port !== 80 && port !== 443
        ? ["-s", "dev", "--", "--port", String(port)]
        : ["-s", "dev"];
    devProc = spawn("pnpm", devArgs, {
      stdio: "inherit",
      shell: false,
      env: {
        ...process.env,
      },
    });
    startedDev = true;

    const ok = await waitForServer(effectiveBaseUrl, 60_000);
    if (!ok) {
      if (devProc) {
        devProc.kill("SIGINT");
      }
      throw new Error(`Dev server did not become ready at ${effectiveBaseUrl}`);
    }
  }

  try {
    const issueKey = "github/redwoodjs/sdk/issues/552/latest.json";

    const listPrefixes = [
      "github/redwoodjs/sdk/pulls/",
      "github/redwoodjs/sdk/prs/",
      "github/redwoodjs/sdk/pull-requests/",
    ];

    let prKey = null;
    for (const prefix of listPrefixes) {
      const listed = await postJson(effectiveBaseUrl, "/debug/r2-list", {
        prefix,
        limit: 200,
      });
      const keys = Array.isArray(listed.keys) ? listed.keys : [];
      const pick = keys.find((k) => typeof k === "string" && k.endsWith("/latest.json"));
      if (pick) {
        prKey = pick;
        break;
      }
    }

    if (!prKey) {
      throw new Error("Could not find a PR latest.json key under expected prefixes");
    }

    const gateId = crypto.randomUUID();
    const liveNamespace = `prov-live-${gateId}`;
    const simNamespace = `prov-sim-${gateId}`;
    const prefix = MOMENT_GRAPH_NAMESPACE_PREFIX;

    const liveResync = await postJson(effectiveBaseUrl, "/admin/resync", {
      mode: "inline",
      r2Keys: [issueKey, prKey],
      momentGraphNamespace: liveNamespace,
      ...(prefix ? { momentGraphNamespacePrefix: prefix } : null),
    });

    const simStarted = await postJson(effectiveBaseUrl, "/admin/simulation/run/start", {
      r2Keys: [issueKey, prKey],
      momentGraphNamespace: simNamespace,
      ...(prefix ? { momentGraphNamespacePrefix: prefix } : null),
    });
    const runId = simStarted.runId;

    for (let guard = 0; guard < 25; guard++) {
      const adv = await postJson(effectiveBaseUrl, "/admin/simulation/run/advance", { runId });
      if (adv.status === "completed") {
        break;
      }
      if (adv.status === "paused_on_error") {
        break;
      }
    }

    const simRun = await getJson(effectiveBaseUrl, `/admin/simulation/run/${runId}`);

    async function getMomentDebug(momentId, namespace) {
      return await postJson(effectiveBaseUrl, "/admin/moment-debug", {
        momentId,
        momentGraphNamespace: namespace,
        ...(prefix ? { momentGraphNamespacePrefix: prefix } : null),
        includeDocumentAudit: true,
        documentAuditLimit: 5,
      });
    }

    async function getAnyMomentIdForDocument(namespace, documentId) {
      const audit = await postJson(effectiveBaseUrl, "/admin/document-audit", {
        documentId,
        momentGraphNamespace: namespace,
        ...(prefix ? { momentGraphNamespacePrefix: prefix } : null),
        limit: 50,
      });
      const id = pickMomentIdFromDocumentAudit(audit.logs);
      if (id) {
        return id;
      }
      const stats = await postJson(effectiveBaseUrl, "/admin/tree-stats", {
        momentGraphNamespace: namespace,
        ...(prefix ? { momentGraphNamespacePrefix: prefix } : null),
        highImportanceCutoff: 0.0,
        sampleLimit: 2000,
        limit: 200,
      });
      const roots = Array.isArray(stats.roots) ? stats.roots : [];
      const match = roots.find((r) => r?.rootDocumentId === documentId);
      return match?.rootId ?? (roots[0]?.rootId ?? null);
    }

    const liveIssueMomentId = await getAnyMomentIdForDocument(liveNamespace, issueKey);
    const livePrMomentId = await getAnyMomentIdForDocument(liveNamespace, prKey);
    const simIssueMomentId = await getAnyMomentIdForDocument(simNamespace, issueKey);
    const simPrMomentId = await getAnyMomentIdForDocument(simNamespace, prKey);

    if (!liveIssueMomentId || !livePrMomentId || !simIssueMomentId || !simPrMomentId) {
      throw new Error("Could not resolve sample moment IDs for one or more documents");
    }

    const liveIssueDebug = await getMomentDebug(liveIssueMomentId, liveNamespace);
    const livePrDebug = await getMomentDebug(livePrMomentId, liveNamespace);
    const simIssueDebug = await getMomentDebug(simIssueMomentId, simNamespace);
    const simPrDebug = await getMomentDebug(simPrMomentId, simNamespace);

    const out = {
      inputs: {
        issueKey,
        prKey,
        momentGraphNamespacePrefix: prefix,
        liveNamespace,
        simNamespace,
        simRunId: runId,
      },
      live: {
        resync: liveResync,
        issue: summarizeProvenance(liveIssueDebug.moment),
        pr: summarizeProvenance(livePrDebug.moment),
      },
      simulation: {
        run: simRun,
        issue: summarizeProvenance(simIssueDebug.moment),
        pr: summarizeProvenance(simPrDebug.moment),
      },
    };

    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } finally {
    if (startedDev && devProc) {
      devProc.kill("SIGINT");
      await sleep(250);
      if (!devProc.killed) {
        devProc.kill("SIGKILL");
      }
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});

