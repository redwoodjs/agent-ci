const BASE_URL = process.env.MACHINEN_BASE_URL ?? "http://localhost:5173";
const API_KEY = process.env.MACHINEN_API_KEY ?? "";

export function authHeaders() {
  if (!API_KEY) {
    throw new Error("Missing MACHINEN_API_KEY env var");
  }
  return {
    Authorization: `Bearer ${API_KEY}`,
  };
}

export async function postJson(path, body) {
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

export async function getJson(path) {
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

export async function pollUntilPhase(runId, targetPhase, options = {}) {
  const timeout = options.timeout ?? 240000;
  const interval = options.interval ?? 2000;
  const start = Date.now();
  let lastKnown = null;
  while (Date.now() - start < timeout) {
    const res = await postJson("/admin/simulation/run/advance", { runId });
    lastKnown = res;
    if (res.status === "paused_on_error") {
      const run = await getJson(`/admin/simulation/run/${runId}`);
      console.error("Simulation error detailed:", JSON.stringify(run.lastError, null, 2));
      throw new Error(`Simulation paused on error: ${JSON.stringify(res)}`);
    }
    if (res.currentPhase === targetPhase || res.status === "completed") {
      return res;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Timed out waiting for phase ${targetPhase} (last known: ${JSON.stringify(lastKnown)})`);
}

export async function pollUntilCompleted(runId, options = {}) {
  const timeout = options.timeout ?? 300000;
  const interval = options.interval ?? 2000;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const res = await postJson("/admin/simulation/run/advance", { runId });
    if (res.status === "completed") {
      return res;
    }
    if (res.status === "paused_on_error") {
      const run = await getJson(`/admin/simulation/run/${runId}`);
      console.error("Simulation error detailed:", JSON.stringify(run.lastError, null, 2));
      throw new Error(`Simulation paused on error: ${JSON.stringify(res)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Timed out waiting for completion`);
}
