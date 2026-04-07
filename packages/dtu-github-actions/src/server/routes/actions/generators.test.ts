import { describe, it, expect } from "vitest";
import { createJobResponse } from "./generators.js";

describe("createJobResponse", () => {
  const basePayload = {
    id: "1",
    name: "test-job",
    githubRepo: "owner/repo",
    steps: [],
  };

  it("propagates job-level env into Variables", () => {
    const payload = {
      ...basePayload,
      env: { AGENT_CI_LOCAL: "true", MY_VAR: "hello" },
    };

    const response = createJobResponse("1", payload, "http://localhost:3000", "plan-1");
    const body = JSON.parse(response.Body);
    const vars = body.Variables;

    expect(vars.AGENT_CI_LOCAL).toEqual({ Value: "true", IsSecret: false });
    expect(vars.MY_VAR).toEqual({ Value: "hello", IsSecret: false });
  });

  it("propagates job-level env into ContextData.env", () => {
    const payload = {
      ...basePayload,
      env: { AGENT_CI_LOCAL: "true" },
    };

    const response = createJobResponse("1", payload, "http://localhost:3000", "plan-1");
    const body = JSON.parse(response.Body);

    // ContextData.env should be a ContextData object with type 2 (mapping)
    expect(body.ContextData.env).toBeDefined();
    expect(body.ContextData.env.t).toBe(2);
    const entries = body.ContextData.env.d;
    const localEntry = entries.find((e: any) => e.k === "AGENT_CI_LOCAL");
    expect(localEntry).toBeDefined();
    expect(localEntry.v).toEqual({ t: 0, s: "true" });
  });

  it("propagates job-level env into EnvironmentVariables", () => {
    const payload = {
      ...basePayload,
      env: { AGENT_CI_LOCAL: "true" },
    };

    const response = createJobResponse("1", payload, "http://localhost:3000", "plan-1");
    const body = JSON.parse(response.Body);

    expect(body.EnvironmentVariables).toHaveLength(1);
    const mapping = body.EnvironmentVariables[0];
    expect(mapping.type).toBe(2);
    const entry = mapping.map.find((e: any) => e.Key === "AGENT_CI_LOCAL");
    expect(entry).toBeDefined();
    expect(entry.Value).toBe("true");
  });

  it("step-level env overrides job-level env on conflict", () => {
    const payload = {
      ...basePayload,
      env: { SHARED: "from-job" },
      steps: [{ name: "step1", run: "echo hi", Env: { SHARED: "from-step" } }],
    };

    const response = createJobResponse("1", payload, "http://localhost:3000", "plan-1");
    const body = JSON.parse(response.Body);

    // Variables should have the step-level value (last-write wins)
    expect(body.Variables.SHARED).toEqual({ Value: "from-step", IsSecret: false });

    // ContextData.env should also have the step-level value
    const entries = body.ContextData.env.d;
    const entry = entries.find((e: any) => e.k === "SHARED");
    expect(entry.v).toEqual({ t: 0, s: "from-step" });
  });

  it("omits env from ContextData when no env is provided", () => {
    const response = createJobResponse("1", basePayload, "http://localhost:3000", "plan-1");
    const body = JSON.parse(response.Body);

    expect(body.ContextData.env).toBeUndefined();
    expect(body.EnvironmentVariables).toEqual([]);
  });
});
