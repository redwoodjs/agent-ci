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

test("simulation phase: candidate_sets (persisted candidate lists)", async () => {
  if (!R2_KEY) {
    return;
  }

  const started = await postJson("/admin/simulation/run/start", {
    r2Keys: [R2_KEY],
  });
  const runId = started.runId;

  await postJson("/admin/simulation/run/advance", { runId }); // ingest_diff -> micro_batches
  await postJson("/admin/simulation/run/advance", { runId }); // micro_batches -> macro_synthesis
  await postJson("/admin/simulation/run/advance", { runId }); // macro_synthesis -> macro_classification
  await postJson("/admin/simulation/run/advance", { runId }); // macro_classification -> materialize_moments
  await postJson("/admin/simulation/run/advance", { runId }); // materialize_moments -> deterministic_linking
  const advE = await postJson("/admin/simulation/run/advance", { runId }); // deterministic_linking -> candidate_sets
  assert.equal(advE.status, "running");
  assert.equal(advE.currentPhase, "candidate_sets");

  const advF = await postJson("/admin/simulation/run/advance", { runId }); // candidate_sets -> timeline_fit
  assert.equal(advF.status, "running");
  assert.equal(advF.currentPhase, "timeline_fit");

  const sets = await getJson(`/admin/simulation/run/${runId}/candidate-sets`);
  assert.ok(Array.isArray(sets.sets));
  assert.ok(sets.sets.length >= 0);
  for (const s of sets.sets) {
    assert.equal(typeof s.childMomentId, "string");
    assert.ok(Array.isArray(s.candidates));
  }
});

