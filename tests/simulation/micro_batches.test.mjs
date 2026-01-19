import test from "node:test";
import assert from "node:assert/strict";
import { postJson, getJson, waitForPhase } from "./test_utils.mjs";

const DEFAULT_R2_KEY = "github/redwoodjs/sdk/issues/552/latest.json";
const R2_KEY = process.env.MACHINEN_TEST_R2_KEY ?? DEFAULT_R2_KEY;

test("simulation phase: micro_batches (cache reuse without LLM)", async () => {
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

  const batches1 = await getJson(
    `/admin/simulation/run/${runId}/micro-batches?r2Key=${encodeURIComponent(
      R2_KEY
    )}`
  );
  assert.ok(Array.isArray(batches1.batches));
  assert.ok(batches1.batches.length > 0);
  assert.ok(
    batches1.batches.every(
      (b) =>
        typeof b.batchHash === "string" &&
        b.batchHash.length > 0 &&
        typeof b.promptContextHash === "string" &&
        b.promptContextHash.length > 0
    )
  );
  const batchHashes1 = batches1.batches.map((b) => b.batchHash);

  const restart = await postJson("/admin/simulation/run/restart", {
    runId,
    phase: "micro_batches",
  });
  assert.equal(restart.success, true);

  await postJson("/admin/simulation/run/advance", { runId });
  await waitForPhase(runId, "macro_synthesis");

  const batches2 = await getJson(
    `/admin/simulation/run/${runId}/micro-batches?r2Key=${encodeURIComponent(
      R2_KEY
    )}`
  );
  assert.ok(Array.isArray(batches2.batches));
  assert.ok(batches2.batches.length > 0);
  assert.ok(batches2.batches.every((b) => b.status === "cached"));
  const batchHashes2 = batches2.batches.map((b) => b.batchHash);
  assert.deepEqual(batchHashes2, batchHashes1);
});
