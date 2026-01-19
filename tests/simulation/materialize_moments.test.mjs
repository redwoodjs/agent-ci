import test from "node:test";
import assert from "node:assert/strict";
import { postJson, getJson, waitForPhase } from "./test_utils.mjs";

const DEFAULT_R2_KEY = "github/redwoodjs/sdk/issues/552/latest.json";
const R2_KEY = process.env.MACHINEN_TEST_R2_KEY ?? DEFAULT_R2_KEY;

test("simulation phase: materialize_moments (moments exist + idempotent)", async () => {
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

  await postJson("/admin/simulation/run/advance", { runId });
  await waitForPhase(runId, "deterministic_linking");

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

  await postJson("/admin/simulation/run/advance", { runId });
  await waitForPhase(runId, "deterministic_linking");

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
