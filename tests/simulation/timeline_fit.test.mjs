import test from "node:test";
import assert from "node:assert/strict";
import { postJson, getJson, waitForPhase } from "./test_utils.mjs";

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

  await postJson("/admin/simulation/run/advance", { runId }); // -> micro_batches
  await waitForPhase(runId, "micro_batches");

  await postJson("/admin/simulation/run/advance", { runId }); // -> macro_synthesis
  await waitForPhase(runId, "macro_synthesis");

  await postJson("/admin/simulation/run/advance", { runId }); // -> macro_classification
  await waitForPhase(runId, "macro_classification");

  await postJson("/admin/simulation/run/advance", { runId }); // -> materialize_moments
  await waitForPhase(runId, "materialize_moments");

  await postJson("/admin/simulation/run/advance", { runId }); // -> deterministic_linking
  await waitForPhase(runId, "deterministic_linking");

  await postJson("/admin/simulation/run/advance", { runId }); // -> candidate_sets
  await waitForPhase(runId, "candidate_sets");

  await postJson("/admin/simulation/run/advance", { runId }); // -> timeline_fit
  await waitForPhase(runId, "timeline_fit");

  await postJson("/admin/simulation/run/advance", { runId }); // -> completed
  const run = await waitForPhase(runId, "completed");
  assert.equal(run.status, "completed");

  const decisions = await getJson(
    `/admin/simulation/run/${runId}/timeline-fit-decisions`
  );
  assert.ok(Array.isArray(decisions.decisions));
});
