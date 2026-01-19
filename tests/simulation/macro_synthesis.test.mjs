import test from "node:test";
import assert from "node:assert/strict";
import { postJson, getJson, waitForPhase } from "./test_utils.mjs";

const DEFAULT_R2_KEY = "github/redwoodjs/sdk/issues/552/latest.json";
const R2_KEY = process.env.MACHINEN_TEST_R2_KEY ?? DEFAULT_R2_KEY;

test("simulation phase: macro_synthesis (stream identity caching)", async () => {
  if (!R2_KEY) {
    return;
  }

  const started = await postJson("/admin/simulation/run/start", {
    r2Keys: [R2_KEY],
  });
  const runId = started.runId;

  await postJson("/admin/simulation/run/advance", { runId });
  await waitForPhase(runId, "micro_batches");

  await postJson("/admin/simulation/run/advance", { runId });
  await waitForPhase(runId, "macro_synthesis");

  await postJson("/admin/simulation/run/advance", { runId });
  await waitForPhase(runId, "macro_classification");

  await postJson("/admin/simulation/run/advance", { runId });
  await waitForPhase(runId, "materialize_moments");

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

  await postJson("/admin/simulation/run/advance", { runId });
  await waitForPhase(runId, "macro_classification");

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
