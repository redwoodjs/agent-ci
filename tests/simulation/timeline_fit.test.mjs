import test from "node:test";
import assert from "node:assert/strict";
import { postJson, getJson, pollUntilPhase, pollUntilCompleted } from "./test-utils.mjs";

const DEFAULT_R2_KEY = "github/redwoodjs/sdk/issues/552/latest.json";
const R2_KEY = process.env.MACHINEN_TEST_R2_KEY ?? DEFAULT_R2_KEY;

test("simulation phase: timeline_fit (decisions persisted, run completes)", async () => {
  if (!R2_KEY) {
    return;
  }

  const started = await postJson("/admin/simulation/run/start", {
    r2Keys: [R2_KEY],
  });
  const runId = started.runId;

  // Poll until completion (timeline_fit is the last phase)
  await pollUntilCompleted(runId);

  const decisions = await getJson(
    `/admin/simulation/run/${runId}/timeline-fit-decisions`
  );
  assert.ok(Array.isArray(decisions.decisions));
  assert.ok(decisions.decisions.length >= 0);
  for (const d of decisions.decisions) {
      assert.ok(d.childMomentId);
      assert.ok(d.outcome);
  }
});
