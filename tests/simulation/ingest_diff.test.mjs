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

function isMissingFixtureError(run) {
  const lastError = run?.lastError;
  const msg = typeof lastError?.message === "string" ? lastError.message : "";
  const failures = Array.isArray(lastError?.failures) ? lastError.failures : [];
  const failureMsg = failures
    .map((f) => (typeof f?.error === "string" ? f.error : ""))
    .join("\n");

  if (!msg.includes("Phase A ingest+diff failed")) {
    return false;
  }

  return (
    failureMsg.includes("R2 object not found") ||
    failureMsg.includes("Missing R2 etag")
  );
}

test("simulation phase: ingest_diff (etag diff)", async (t) => {
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
  if (adv1.status === "paused_on_error") {
    const run = await getJson(`/admin/simulation/run/${runId}`);
    if (isMissingFixtureError(run)) {
      t.skip();
      return;
    }
  }

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
