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

test("simulation phase: deterministic_linking (intra-stream chaining + decision artifacts)", async () => {
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
  assert.equal(adv3.currentPhase, "macro_classification");

  const adv4 = await postJson("/admin/simulation/run/advance", { runId });
  assert.equal(adv4.status, "running");
  assert.equal(adv4.currentPhase, "materialize_moments");

  const adv5 = await postJson("/admin/simulation/run/advance", { runId });
  assert.equal(adv5.status, "running");
  assert.equal(adv5.currentPhase, "deterministic_linking");

  const before = await getJson(
    `/admin/simulation/run/${runId}/materialized-moments?r2Key=${encodeURIComponent(
      R2_KEY
    )}`
  );
  assert.ok(Array.isArray(before.moments));
  assert.ok(before.moments.length > 0);
  assert.ok(before.moments.every((m) => m.parentId === null));

  const adv6 = await postJson("/admin/simulation/run/advance", { runId });
  assert.equal(adv6.status, "running");
  assert.equal(adv6.currentPhase, "candidate_sets");

  const after = await getJson(
    `/admin/simulation/run/${runId}/materialized-moments?r2Key=${encodeURIComponent(
      R2_KEY
    )}`
  );
  assert.ok(Array.isArray(after.moments));
  assert.equal(after.moments.length, before.moments.length);

  const roots = after.moments.filter((m) => m.parentId === null);
  assert.ok(roots.length >= 1);
  if (after.moments.length > 1) {
    assert.ok(after.moments.some((m) => m.parentId !== null));
  }

  const decisions = await getJson(
    `/admin/simulation/run/${runId}/link-decisions`
  );
  assert.ok(Array.isArray(decisions.decisions));
  assert.ok(decisions.decisions.length > 0);
});
