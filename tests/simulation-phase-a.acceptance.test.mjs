import test from "node:test";
import assert from "node:assert/strict";

const BASE_URL = process.env.MACHINEN_BASE_URL ?? "http://localhost:5173";
const API_KEY = process.env.MACHINEN_API_KEY ?? "";
const R2_KEY = process.env.MACHINEN_TEST_R2_KEY ?? "";

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

test("simulation phase A acceptance (requires MACHINEN_TEST_R2_KEY)", async (t) => {
  if (!R2_KEY) {
    t.skip();
    return;
  }

  const started = await postJson("/admin/simulation/run/start", {
    r2Keys: [R2_KEY],
  });
  assert.equal(typeof started?.runId, "string");
  assert.ok(started.runId.length > 0);

  const runId = started.runId;

  const adv1 = await postJson("/admin/simulation/run/advance", { runId });
  assert.equal(adv1.status, "running");
  assert.equal(adv1.currentPhase, "micro_batches");

  const docs1 = await getJson(`/admin/simulation/run/${runId}/documents`);
  assert.ok(Array.isArray(docs1.documents));
  assert.equal(docs1.documents.length, 1);
  assert.equal(docs1.documents[0].r2Key, R2_KEY);
  assert.equal(typeof docs1.documents[0].etag, "string");
  assert.ok(docs1.documents[0].etag.length > 0);

  const restart = await postJson("/admin/simulation/run/restart", {
    runId,
    phase: "ingest_diff",
  });
  assert.equal(restart.success, true);

  const adv2 = await postJson("/admin/simulation/run/advance", { runId });
  assert.equal(adv2.status, "running");
  assert.equal(adv2.currentPhase, "micro_batches");

  const docs2 = await getJson(`/admin/simulation/run/${runId}/documents`);
  assert.ok(Array.isArray(docs2.documents));
  assert.equal(docs2.documents.length, 1);
  assert.equal(docs2.documents[0].r2Key, R2_KEY);
  assert.equal(docs2.documents[0].etag, docs1.documents[0].etag);
  assert.equal(docs2.documents[0].changed, false);
});

