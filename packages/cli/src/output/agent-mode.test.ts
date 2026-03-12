import { describe, it, expect, afterEach } from "vitest";
import { isAgentMode, setQuietMode } from "./agent-mode.js";

describe("isAgentMode", () => {
  const originalEnv = process.env.AI_AGENT;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AI_AGENT;
    } else {
      process.env.AI_AGENT = originalEnv;
    }
    setQuietMode(false);
  });

  it("returns true when AI_AGENT=1", () => {
    process.env.AI_AGENT = "1";
    expect(isAgentMode()).toBe(true);
  });

  it("returns false when AI_AGENT is unset", () => {
    delete process.env.AI_AGENT;
    expect(isAgentMode()).toBe(false);
  });

  it("returns false when AI_AGENT is something other than 1", () => {
    process.env.AI_AGENT = "true";
    expect(isAgentMode()).toBe(false);
  });

  it("returns true when --quiet flag is set", () => {
    delete process.env.AI_AGENT;
    setQuietMode(true);
    expect(isAgentMode()).toBe(true);
  });

  it("returns true when both --quiet and AI_AGENT=1 are set", () => {
    process.env.AI_AGENT = "1";
    setQuietMode(true);
    expect(isAgentMode()).toBe(true);
  });
});
