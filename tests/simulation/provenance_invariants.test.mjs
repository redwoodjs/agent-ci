import test from "node:test";
import assert from "node:assert/strict";

const BASE_URL = process.env.MACHINEN_BASE_URL ?? "http://localhost:5173";
const API_KEY = process.env.MACHINEN_API_KEY ?? "";

const DEFAULT_R2_KEY = "github/redwoodjs/sdk/issues/552/latest.json";
const R2_KEY = process.env.MACHINEN_TEST_R2_KEY ?? DEFAULT_R2_KEY;

function authHeaders() {
  if (!API_KEY) {
    throw new Error("Missing MACHINEN_API_KEY env var");
  }
  return {
    Authorization: `Bearer ${API_KEY}`,
  };
}

async function postJson(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
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

async function getJson(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "GET",
    headers: {
      ...authHeaders(),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status} ${text}`);
  }
  return JSON.parse(text);
}

function assertIsoDateString(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(value.trim().length > 0, `${label} must be non-empty`);
  const ms = Date.parse(value);
  assert.ok(Number.isFinite(ms), `${label} must parse as a date`);
}

test("provenance invariants: moments include document identity + author/createdAt", async () => {
  if (!R2_KEY) {
    return;
  }

  const started = await postJson("/admin/simulation/run/start", {
    r2Keys: [R2_KEY],
  });
  const runId = started.runId;

  const adv1 = await postJson("/admin/simulation/run/advance", { runId });
  assert.equal(adv1.status, "running");
  assert.equal(adv1.currentPhase, "micro_batches");

  const adv2 = await postJson("/admin/simulation/run/advance", { runId });
  assert.equal(adv2.status, "running");
  assert.equal(adv2.currentPhase, "macro_synthesis");

  const adv3 = await postJson("/admin/simulation/run/advance", { runId });
  assert.equal(adv3.status, "running");
  assert.equal(adv3.currentPhase, "materialize_moments");

  const adv4 = await postJson("/admin/simulation/run/advance", { runId });
  if (adv4.status !== "running") {
    const run = await getJson(`/admin/simulation/run/${runId}`);
    throw new Error(
      `advance(materialize_moments) did not stay running: ${JSON.stringify(run)}`
    );
  }

  const run = await getJson(`/admin/simulation/run/${runId}`);
  const baseNamespace = run?.momentGraphNamespace ?? null;
  const namespacePrefix = run?.momentGraphNamespacePrefix ?? null;

  const materialized = await getJson(
    `/admin/simulation/run/${runId}/materialized-moments?r2Key=${encodeURIComponent(
      R2_KEY
    )}`
  );
  assert.ok(Array.isArray(materialized.moments));
  assert.ok(materialized.moments.length > 0);

  const momentId = materialized.moments[0]?.momentId;
  assert.equal(typeof momentId, "string");
  assert.ok(momentId.trim().length > 0);

  const debug = await postJson("/admin/moment-debug", {
    momentId,
    momentGraphNamespace: baseNamespace,
    momentGraphNamespacePrefix: namespacePrefix,
    includeDocumentAudit: false,
  });

  const m = debug?.moment;
  assert.equal(m?.documentId, R2_KEY);
  assertIsoDateString(m?.createdAt, "moment.createdAt");
  assert.equal(typeof m?.author, "string");
  assert.ok(m.author.trim().length > 0);

  const sm = m?.sourceMetadata;
  assert.ok(sm && typeof sm === "object");

  const doc = sm.document;
  assert.ok(doc && typeof doc === "object");
  assert.equal(doc.documentId, R2_KEY);
  assert.equal(typeof doc.source, "string");
  assert.ok(doc.source.length > 0);
  assert.equal(typeof doc.type, "string");
  assert.ok(doc.type.length > 0);
  assert.ok(doc.url === null || typeof doc.url === "string");
  assert.ok(doc.identity === null || typeof doc.identity === "object");

  const tr = sm.timeRange;
  if (tr !== undefined && tr !== null) {
    assert.ok(typeof tr === "object");
    assertIsoDateString(tr.start, "moment.sourceMetadata.timeRange.start");
    assertIsoDateString(tr.end, "moment.sourceMetadata.timeRange.end");
  }
});

