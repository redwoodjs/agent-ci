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

test("simulation phase: macro_synthesis (stream identity caching)", async () => {
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

  const out1 = await getJson(
    `/admin/simulation/run/${runId}/macro-outputs?r2Key=${encodeURIComponent(
      R2_KEY
    )}`
  );
  assert.ok(Array.isArray(out1.outputs));
  assert.equal(out1.outputs.length, 1);
  assert.equal(out1.outputs[0].r2Key, R2_KEY);
  assert.equal(typeof out1.outputs[0].microStreamHash, "string");
  assert.ok(out1.outputs[0].microStreamHash.length > 0);
  assert.ok(Array.isArray(out1.outputs[0].streams));

  const microStreamHash1 = out1.outputs[0].microStreamHash;

  const restart = await postJson("/admin/simulation/run/restart", {
    runId,
    phase: "macro_synthesis",
  });
  assert.equal(restart.success, true);

  const advAgain = await postJson("/admin/simulation/run/advance", { runId });
  assert.equal(advAgain.status, "running");
  assert.equal(advAgain.currentPhase, "macro_classification");

  const out2 = await getJson(
    `/admin/simulation/run/${runId}/macro-outputs?r2Key=${encodeURIComponent(
      R2_KEY
    )}`
  );
  assert.ok(Array.isArray(out2.outputs));
  assert.equal(out2.outputs.length, 1);
  assert.equal(out2.outputs[0].microStreamHash, microStreamHash1);

  const eventsRes = await getJson(
    `/admin/simulation/run/${runId}/events?limit=200`
  );
  assert.ok(Array.isArray(eventsRes.events));
  const phaseEnd = eventsRes.events.find(
    (e) => e.kind === "phase.end" && e.payload?.phase === "macro_synthesis"
  );
  assert.ok(phaseEnd);
});

