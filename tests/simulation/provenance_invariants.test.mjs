import test from "node:test";
import assert from "node:assert/strict";
import { postJson, getJson, waitForPhase } from "./test_utils.mjs";

function assertIsoDateString(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(value.trim().length > 0, `${label} must be non-empty`);
  const ms = Date.parse(value);
  assert.ok(Number.isFinite(ms), `${label} must parse as a date`);
}

test("provenance invariants: moments include document identity + author/createdAt", async () => {
  if (!process.env.MACHINEN_TEST_R2_KEY && !process.env.GITHUB_TOKEN) {
    // Requires either a specific R2 key or GitHub token for default
    // Skip if not available
    return;
  }
  const R2_KEY = process.env.MACHINEN_TEST_R2_KEY ?? "github/redwoodjs/sdk/issues/552/latest.json";

  const started = await postJson("/admin/simulation/run/start", {
    r2Keys: [R2_KEY],
  });
  const runId = started.runId;

  await postJson("/admin/simulation/run/advance", { runId });
  await waitForPhase(runId, "micro_batches");

  await postJson("/admin/simulation/run/advance", { runId });
  await waitForPhase(runId, "macro_synthesis");

  await postJson("/admin/simulation/run/advance", { runId });
  await waitForPhase(runId, "macro_classification");

  await postJson("/admin/simulation/run/advance", { runId });
  await waitForPhase(runId, "materialize_moments");

  await postJson("/admin/simulation/run/advance", { runId });
  await waitForPhase(runId, "deterministic_linking");

  const run = await getJson(`/admin/simulation/run/${runId}`);
  const baseNamespace = run?.momentGraphNamespace ?? null;
  const namespacePrefix = run?.momentGraphNamespacePrefix ?? null;

  const materialized = await getJson(
    `/admin/simulation/run/${runId}/materialized-moments?r2Key=${encodeURIComponent(
      R2_KEY
    )}`
  );
  assert.ok(Array.isArray(materialized.moments));
  assert.ok(materialized.moments.length > 0);

  const momentId = materialized.moments[0]?.momentId;
  assert.equal(typeof momentId, "string");
  assert.ok(momentId.trim().length > 0);

  const debug = await postJson("/admin/moment-debug", {
    momentId,
    momentGraphNamespace: baseNamespace,
    momentGraphNamespacePrefix: namespacePrefix,
    includeDocumentAudit: false,
  });

  const m = debug?.moment;
  assert.equal(m?.documentId, R2_KEY);
  assertIsoDateString(m?.createdAt, "moment.createdAt");
  assert.equal(typeof m?.author, "string");
  assert.ok(m.author.trim().length > 0);

  const sm = m?.sourceMetadata;
  assert.ok(sm && typeof sm === "object");

  const doc = sm.document;
  assert.ok(doc && typeof doc === "object");
  assert.equal(doc.documentId, R2_KEY);
  assert.equal(typeof doc.source, "string");
  assert.ok(doc.source.length > 0);
  assert.equal(typeof doc.type, "string");
  assert.ok(doc.type.length > 0);
  assert.ok(doc.url === null || typeof doc.url === "string");
  assert.ok(doc.identity === null || typeof doc.identity === "object");

  const tr = sm.timeRange;
  if (tr !== undefined && tr !== null) {
    assert.ok(typeof tr === "object");
    assertIsoDateString(tr.start, "moment.sourceMetadata.timeRange.start");
    assertIsoDateString(tr.end, "moment.sourceMetadata.timeRange.end");
  }
});
