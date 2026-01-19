import test from "node:test";
import assert from "node:assert/strict";
import { postJson, getJson, waitForPhase } from "./test_utils.mjs";

test("simulation runner contract: start/advance/pause/resume/restart + events", async () => {
  const started = await postJson("/admin/simulation/run/start", {});
  assert.equal(typeof started?.runId, "string");
  assert.ok(started.runId.length > 0);

  const runId = started.runId;

  const run0 = await getJson(`/admin/simulation/run/${runId}`);
  assert.equal(run0.runId, runId);
  assert.equal(run0.status, "running");
  assert.equal(run0.currentPhase, "ingest_diff");

  await postJson("/admin/simulation/run/advance", { runId });
  await waitForPhase(runId, "micro_batches");

  const paused = await postJson("/admin/simulation/run/pause", { runId });
  assert.equal(paused.success, true);

  const advWhilePaused = await postJson("/admin/simulation/run/advance", {
    runId,
  });
  // advance returns current state if it can't advance
  assert.equal(advWhilePaused.status, "paused_manual");

  const resumed = await postJson("/admin/simulation/run/resume", { runId });
  assert.equal(resumed.success, true);

  await postJson("/admin/simulation/run/advance", { runId });
  await waitForPhase(runId, "macro_synthesis");

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
