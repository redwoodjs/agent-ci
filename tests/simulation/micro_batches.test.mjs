import test from "node:test";
import assert from "node:assert/strict";

const BASE_URL = process.env.MACHINEN_BASE_URL ?? "http://localhost:5173";
const API_KEY = process.env.MACHINEN_API_KEY ?? "";

const DEFAULT_R2_KEY = "github/redwoodjs/sdk/issues/552/latest.json";
const R2_KEY = process.env.MACHINEN_TEST_R2_KEY ?? DEFAULT_R2_KEY;

function authHeaders() {
  if (!API_KEY) {
    throw new Error("Missing MACHINEN_API_KEY env var");
  }
  return {
    Authorization: `Bearer ${API_KEY}`,
  };
}

async function postJson(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${path} failed: ${res.status} ${text}`);
  }
  return JSON.parse(text);
}

async function getJson(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "GET",
    headers: {
      ...authHeaders(),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status} ${text}`);
  }
  return JSON.parse(text);
}

test("simulation phase: micro_batches (cache reuse without LLM)", async () => {
  if (!R2_KEY) {
    return;
  }

  const started = await postJson("/admin/simulation/run/start", {
    r2Keys: [R2_KEY],
  });
  const runId = started.runId;

  const advA = await postJson("/admin/simulation/run/advance", { runId });
  assert.equal(advA.status, "running");
  assert.equal(advA.currentPhase, "micro_batches");

  const advB = await postJson("/admin/simulation/run/advance", { runId });
  assert.equal(advB.status, "running");
  assert.equal(advB.currentPhase, "macro_synthesis");

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

  const advBAgain = await postJson("/admin/simulation/run/advance", { runId });
  assert.equal(advBAgain.status, "running");
  assert.equal(advBAgain.currentPhase, "macro_synthesis");

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

