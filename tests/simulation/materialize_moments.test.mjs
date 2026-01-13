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

test("simulation phase: materialize_moments (moments exist + idempotent)", async () => {
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
      `advance(materialize_moments) did not stay running: ${JSON.stringify(
        run
      )}`
    );
  }
  assert.equal(adv4.currentPhase, "deterministic_linking");

  const m1 = await getJson(
    `/admin/simulation/run/${runId}/materialized-moments?r2Key=${encodeURIComponent(
      R2_KEY
    )}`
  );
  assert.ok(Array.isArray(m1.moments));
  assert.ok(m1.moments.length > 0);
  assert.ok(m1.moments.every((m) => m.parentId === null));

  const ids1 = m1.moments.map((m) => m.momentId);
  assert.equal(new Set(ids1).size, ids1.length);

  const restart = await postJson("/admin/simulation/run/restart", {
    runId,
    phase: "materialize_moments",
  });
  assert.equal(restart.success, true);

  const advAgain = await postJson("/admin/simulation/run/advance", { runId });
  assert.equal(advAgain.status, "running");
  assert.equal(advAgain.currentPhase, "deterministic_linking");

  const m2 = await getJson(
    `/admin/simulation/run/${runId}/materialized-moments?r2Key=${encodeURIComponent(
      R2_KEY
    )}`
  );
  assert.ok(Array.isArray(m2.moments));
  assert.equal(m2.moments.length, m1.moments.length);
  const ids2 = m2.moments.map((m) => m.momentId);
  assert.deepEqual(ids2, ids1);
});

