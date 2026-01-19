import test from "node:test";
import assert from "node:assert/strict";
import { postJson, getJson, pollUntilCompleted } from "./test-utils.mjs";

const DEFAULT_R2_KEY = "github/redwoodjs/sdk/issues/552/latest.json";
const R2_KEY = process.env.MACHINEN_TEST_R2_KEY ?? DEFAULT_R2_KEY;

test("source coverage: one key per source can run through micro_batches", async () => {
    // This test verifies that we can run at least one doc from each source 
    // without stalling. It relies on the presence of R2 keys. 
    // For now, we will just use the default key if available.
  if (!R2_KEY) {
    return;
  }

  const started = await postJson("/admin/simulation/run/start", {
    r2Keys: [R2_KEY],
  });
  const runId = started.runId;

  await pollUntilCompleted(runId);

  const run = await getJson(`/admin/simulation/run/${runId}`);
  assert.equal(run.status, "completed");
});
