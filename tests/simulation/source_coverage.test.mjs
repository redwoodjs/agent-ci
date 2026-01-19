import test from "node:test";
import assert from "node:assert/strict";

const BASE_URL = process.env.MACHINEN_BASE_URL ?? "http://localhost:5173";
const API_KEY = process.env.MACHINEN_API_KEY ?? "";

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

async function listKeys(prefix) {
  const res = await postJson("/debug/r2-list", { prefix, limit: 200 });
  return Array.isArray(res.keys) ? res.keys : [];
}

test("source coverage: one key per source can run through micro_batches", async (t) => {
  if (!API_KEY) {
    t.skip("Missing MACHINEN_API_KEY");
    return;
  }

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

  const adv1 = await postJson("/admin/simulation/run/advance", { runId });
  assert.equal(adv1.status, "running");
  assert.equal(adv1.currentPhase, "micro_batches");

  const adv2 = await postJson("/admin/simulation/run/advance", { runId });
  if (adv2.status !== "running") {
    const run = await getJson(`/admin/simulation/run/${runId}`);
    throw new Error(`micro_batches paused: ${JSON.stringify(run)}`);
  }
  assert.equal(adv2.currentPhase, "macro_synthesis");
});

