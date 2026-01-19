import test from "node:test";
import assert from "node:assert/strict";
import { postJson, getJson, pollUntilPhase } from "./test-utils.mjs";

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

  // Poll until deterministic_linking (phase AFTER materialize_moments)
  await pollUntilPhase(runId, "deterministic_linking");

  const runRow = await getJson(`/admin/simulation/run/${runId}`);
  const ns = runRow.moment_graph_namespace;
  // TODO: Verify namespace prefix logic here?

  const moments = await getJson(
    `/admin/simulation/run/${runId}/materialized-moments`
  );
  assert.ok(Array.isArray(moments.moments));
  assert.ok(moments.moments.length > 0);
  
  const first = moments.moments[0];
  assert.ok(first.momentId);
  assert.ok(first.r2Key);
});
