import test from "node:test";
import assert from "node:assert/strict";

const BASE_URL = process.env.MACHINEN_BASE_URL ?? "http://localhost:5173";
const API_KEY = process.env.MACHINEN_API_KEY ?? "";

function authHeaders() {
  if (!API_KEY) {
    throw new Error(
      "Missing MACHINEN_API_KEY env var (expected the same API_KEY as .dev.vars)"
    );
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

test("simulation runner contract: start/advance/pause/resume/restart + events", async () => {
  const started = await postJson("/admin/simulation/run/start", {});
  assert.equal(typeof started?.runId, "string");
  assert.ok(started.runId.length > 0);

  const runId = started.runId;

  const run0 = await getJson(`/admin/simulation/run/${runId}`);
  assert.equal(run0.runId, runId);
  assert.equal(run0.status, "running");
  assert.equal(run0.currentPhase, "ingest_diff");

  const adv1 = await postJson("/admin/simulation/run/advance", { runId });
  assert.equal(adv1.status, "running");
  assert.equal(adv1.currentPhase, "micro_batches");

  const paused = await postJson("/admin/simulation/run/pause", { runId });
  assert.equal(paused.success, true);

  const advWhilePaused = await postJson("/admin/simulation/run/advance", {
    runId,
  });
  assert.equal(advWhilePaused.status, "paused_manual");
  assert.equal(advWhilePaused.currentPhase, "micro_batches");

  const resumed = await postJson("/admin/simulation/run/resume", { runId });
  assert.equal(resumed.success, true);

  const adv2 = await postJson("/admin/simulation/run/advance", { runId });
  assert.equal(adv2.status, "running");
  assert.equal(adv2.currentPhase, "macro_synthesis");

  const restarted = await postJson("/admin/simulation/run/restart", {
    runId,
    phase: "ingest_diff",
  });
  assert.equal(restarted.success, true);
  assert.equal(restarted.phase, "ingest_diff");

  const runAfter = await getJson(`/admin/simulation/run/${runId}`);
  assert.equal(runAfter.status, "running");
  assert.equal(runAfter.currentPhase, "ingest_diff");

  const eventsRes = await getJson(
    `/admin/simulation/run/${runId}/events?limit=100`
  );
  assert.ok(Array.isArray(eventsRes.events));
  const kinds = new Set(eventsRes.events.map((e) => e.kind));
  assert.ok(kinds.has("phase.start"));
  assert.ok(kinds.has("phase.end"));
  assert.ok(kinds.has("run.pause_manual"));
  assert.ok(kinds.has("run.resume"));
  assert.ok(kinds.has("run.restart_from_phase"));
});
