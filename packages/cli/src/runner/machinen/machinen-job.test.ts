// Unit tests for `executeMachinenJob` are intentionally thin: the
// function orchestrates the DTU, machinen runtime, host filesystem, and
// child processes, so most behaviors only manifest end-to-end. We rely
// on:
//
//   - `rootfs.test.ts` for the rootfs download/override pipeline.
//   - `image-mapping.test.ts` for the discovery flow.
//   - The host-side smoke test (`AGENT_CI_MACHINEN=1` against a real
//     workflow) for the boot → run.sh → completion path.
//
// This file just confirms the module exports the expected shape so
// imports don't break silently.

import { describe, expect, it } from "vitest";

import { executeMachinenJob } from "./machinen-job.ts";

describe("machinen-job module", () => {
  it("exports executeMachinenJob", () => {
    expect(typeof executeMachinenJob).toBe("function");
  });
});
