import { describe, it, expect } from "vitest";
import { wrapStepScript, wrapJobSteps } from "./step-wrapper.js";

// ── wrapStepScript ────────────────────────────────────────────────────────────

describe("wrapStepScript", () => {
  it("wraps the original script in a retry loop", () => {
    const wrapped = wrapStepScript("npm test", "Run tests");
    expect(wrapped).toContain("npm test");
    expect(wrapped).toContain('__SIGNALS="/tmp/machinen-signals"');
    expect(wrapped).toContain("while true; do");
    expect(wrapped).toContain("Retrying step...");
  });

  it("includes the step name in the paused signal", () => {
    const wrapped = wrapStepScript("echo hi", "My Step");
    expect(wrapped).toContain("printf '%s\\n%s' 'My Step' \"$__ATTEMPT\" > \"$__SIGNALS/paused\"");
  });

  it("escapes single quotes in step names", () => {
    const wrapped = wrapStepScript("echo hi", "it's a test");
    // Should not contain an unescaped single quote that breaks the shell
    expect(wrapped).toContain("it'\\''s a test");
  });
});

// ── wrapJobSteps ──────────────────────────────────────────────────────────────

describe("wrapJobSteps", () => {
  const scriptStep = {
    Name: "Run tests",
    Reference: { Type: "Script" },
    Inputs: { script: "npm test" },
  };

  const usesStep = {
    Name: "Checkout",
    Reference: { Type: "Repository", Name: "actions/checkout" },
    Inputs: {},
  };

  it("returns steps unchanged when pauseOnFailure is false", () => {
    const result = wrapJobSteps([scriptStep, usesStep], false);
    expect(result).toEqual([scriptStep, usesStep]);
  });

  it("wraps run: steps when pauseOnFailure is true", () => {
    const result = wrapJobSteps([scriptStep, usesStep], true);
    expect(result[0].Inputs.script).toContain("__SIGNALS");
    expect(result[0].Inputs.script).toContain("npm test");
  });

  it("leaves uses: steps untouched", () => {
    const result = wrapJobSteps([scriptStep, usesStep], true);
    expect(result[1]).toEqual(usesStep);
  });

  it("handles undefined/empty steps gracefully", () => {
    expect(wrapJobSteps([], true)).toEqual([]);
    expect(wrapJobSteps(undefined as any, false)).toBeUndefined();
  });
});
