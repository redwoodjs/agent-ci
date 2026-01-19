import test from "node:test";
import assert from "node:assert/strict";
import { postJson, getJson, pollUntilPhase } from "./test-utils.mjs";

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

  // Poll until we reach materialize_moments (which is after macro_synthesis and macro_classification)
  await pollUntilPhase(runId, "materialize_moments");

  const out1 = await getJson(
    `/admin/simulation/run/${runId}/macro-outputs?r2Key=${encodeURIComponent(
      R2_KEY
    )}`
  );
  assert.ok(Array.isArray(out1.outputs));
  assert.equal(out1.outputs.length, 1);
  const microStreamHash1 = out1.outputs[0].microStreamHash;

  const restart = await postJson("/admin/simulation/run/restart", {
    runId,
    phase: "macro_synthesis",
  });
  assert.equal(restart.success, true);

  // Poll again
  await pollUntilPhase(runId, "materialize_moments");

  const out2 = await getJson(
    `/admin/simulation/run/${runId}/macro-outputs?r2Key=${encodeURIComponent(
      R2_KEY
    )}`
  );
  assert.ok(Array.isArray(out2.outputs));
  assert.equal(out2.outputs.length, 1);
  assert.equal(out2.outputs[0].microStreamHash, microStreamHash1);
});

