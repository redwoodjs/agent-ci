import test from "node:test";
import assert from "node:assert/strict";
import { postJson, getJson, pollUntilPhase } from "./test-utils.mjs";

const DEFAULT_R2_KEY = "github/redwoodjs/sdk/issues/552/latest.json";
const R2_KEY = process.env.MACHINEN_TEST_R2_KEY ?? DEFAULT_R2_KEY;

test("simulation phase: candidate_sets (persisted candidate lists)", async () => {
  if (!R2_KEY) {
    return;
  }

  const started = await postJson("/admin/simulation/run/start", {
    r2Keys: [R2_KEY],
  });
  const runId = started.runId;

  await pollUntilPhase(runId, "timeline_fit");

  const sets = await getJson(`/admin/simulation/run/${runId}/candidate-sets`);
  assert.ok(Array.isArray(sets.sets));
  assert.ok(sets.sets.length >= 0);
  for (const s of sets.sets) {
    assert.equal(typeof s.childMomentId, "string");
    assert.ok(Array.isArray(s.candidates));
  }
});
