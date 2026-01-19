import test from "node:test";
import assert from "node:assert/strict";
import { postJson, getJson, waitForPhase } from "./test_utils.mjs";

const DEFAULT_R2_KEY = "github/redwoodjs/sdk/issues/552/latest.json";
const R2_KEY = process.env.MACHINEN_TEST_R2_KEY ?? DEFAULT_R2_KEY;

function isMissingFixtureError(run) {
  const lastError = run?.lastError;
  const msg = typeof lastError?.message === "string" ? lastError.message : "";
  const failures = Array.isArray(lastError?.failures) ? lastError.failures : [];
  const failureMsg = failures
    .map((f) => (typeof f?.error === "string" ? f.error : ""))
    .join("\n");

  if (!msg.includes("Phase A ingest+diff failed")) {
    return false;
  }

  return (
    failureMsg.includes("R2 object not found") ||
    failureMsg.includes("Missing R2 etag")
  );
}

test("simulation phase: ingest_diff (etag diff)", async (t) => {
  if (!R2_KEY) {
    t.skip();
    return;
  }

  const started = await postJson("/admin/simulation/run/start", {
    r2Keys: [R2_KEY],
  });
  assert.equal(typeof started?.runId, "string");
  assert.ok(started.runId.length > 0);

  const runId = started.runId;

  await postJson("/admin/simulation/run/advance", { runId });
  let run;
  try {
    run = await waitForPhase(runId, "micro_batches");
  } catch (e) {
    const r = await getJson(`/admin/simulation/run/${runId}`);
    if (isMissingFixtureError(r)) {
      t.skip();
      return;
    }
    throw e;
  }

  assert.equal(run.status, "running");
  assert.equal(run.currentPhase, "micro_batches");

  const docs1 = await getJson(`/admin/simulation/run/${runId}/documents`);
  assert.ok(Array.isArray(docs1.documents));
  assert.equal(docs1.documents.length, 1);
  assert.equal(docs1.documents[0].r2Key, R2_KEY);
  assert.equal(typeof docs1.documents[0].etag, "string");
  assert.ok(docs1.documents[0].etag.length > 0);

  const restart = await postJson("/admin/simulation/run/restart", {
    runId,
    phase: "ingest_diff",
  });
  assert.equal(restart.success, true);

  await postJson("/admin/simulation/run/advance", { runId });
  const run2 = await waitForPhase(runId, "micro_batches");
  assert.equal(run2.status, "running");
  assert.equal(run2.currentPhase, "micro_batches");

  const docs2 = await getJson(`/admin/simulation/run/${runId}/documents`);
  assert.ok(Array.isArray(docs2.documents));
  assert.equal(docs2.documents.length, 1);
  assert.equal(docs2.documents[0].r2Key, R2_KEY);
  assert.equal(docs2.documents[0].etag, docs1.documents[0].etag);
  assert.equal(docs2.documents[0].changed, false);
});
