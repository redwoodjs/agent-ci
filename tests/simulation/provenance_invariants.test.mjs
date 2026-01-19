import test from "node:test";
import assert from "node:assert/strict";
import { postJson, getJson, pollUntilCompleted } from "./test-utils.mjs";

const DEFAULT_R2_KEY = "github/redwoodjs/sdk/issues/552/latest.json";
const R2_KEY = process.env.MACHINEN_TEST_R2_KEY ?? DEFAULT_R2_KEY;

test("provenance invariants: moments include document identity + author/createdAt", async () => {
  if (!R2_KEY) {
    return;
  }

  const started = await postJson("/admin/simulation/run/start", {
    r2Keys: [R2_KEY],
  });
  const runId = started.runId;

  await pollUntilCompleted(runId);

  const moments = await getJson(
    `/admin/simulation/run/${runId}/materialized-moments`
  );
  
  // Just check one moment for the invariant
  if (moments.moments.length > 0) {
      const m = moments.moments[0];
      assert.ok(m.sourceMetadata);
      assert.ok(m.createdAt);
      assert.ok(m.author);
  }
});
