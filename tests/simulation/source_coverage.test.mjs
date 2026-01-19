import test from "node:test";
import assert from "node:assert/strict";
import { postJson, getJson, waitForPhase } from "./test_utils.mjs";

async function listKeys(prefix) {
  const res = await postJson("/debug/r2-list", { prefix, limit: 200 });
  return Array.isArray(res.keys) ? res.keys : [];
}

test("source coverage: one key per source can run through micro_batches", async (t) => {
  const prefixes = ["github/", "discord/", "cursor/conversations/"];
  const keys = [];

  for (const p of prefixes) {
    const listed = await listKeys(p);
    const first = listed.find((k) => typeof k === "string" && k.startsWith(p));
    if (!first) {
      t.skip(`No keys found for prefix ${p}`);
      return;
    }
    keys.push(first);
  }

  const started = await postJson("/admin/simulation/run/start", {
    r2Keys: keys,
  });
  const runId = started.runId;

  await postJson("/admin/simulation/run/advance", { runId });
  await waitForPhase(runId, "micro_batches");

  await postJson("/admin/simulation/run/advance", { runId });
  const run = await waitForPhase(runId, "macro_synthesis");
  
  assert.equal(run.status, "running");
  assert.equal(run.currentPhase, "macro_synthesis");
});
