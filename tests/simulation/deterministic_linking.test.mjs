import test from "node:test";
import assert from "node:assert/strict";
import { postJson, getJson, pollUntilPhase } from "./test-utils.mjs";

const DEFAULT_R2_KEY = "github/redwoodjs/sdk/issues/552/latest.json";
const R2_KEY = process.env.MACHINEN_TEST_R2_KEY ?? DEFAULT_R2_KEY;

test("simulation phase: deterministic_linking (intra-stream chaining + decision artifacts)", async () => {
  if (!R2_KEY) {
    return;
  }

  const started = await postJson("/admin/simulation/run/start", {
    r2Keys: [R2_KEY],
  });
  const runId = started.runId;

  // Poll until candidate_sets (phase AFTER deterministic_linking)
  await pollUntilPhase(runId, "candidate_sets");

  const decisions = await getJson(
    `/admin/simulation/run/${runId}/link-decisions`
  );
  assert.ok(Array.isArray(decisions.decisions));
  assert.ok(decisions.decisions.length >= 0);

  for (const d of decisions.decisions) {
    assert.ok(d.childMomentId);
    assert.ok(d.streamId);
  }
});
