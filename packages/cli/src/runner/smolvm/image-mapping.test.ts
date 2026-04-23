import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveSmolvmImage, DEFAULT_SMOLVM_IMAGE } from "./image-mapping.js";

describe("resolveSmolvmImage", () => {
  const originalOverride = process.env.AGENT_CI_SMOLVM_IMAGE;
  beforeEach(() => {
    delete process.env.AGENT_CI_SMOLVM_IMAGE;
  });
  afterEach(() => {
    if (originalOverride === undefined) {
      delete process.env.AGENT_CI_SMOLVM_IMAGE;
    } else {
      process.env.AGENT_CI_SMOLVM_IMAGE = originalOverride;
    }
  });

  it("AGENT_CI_SMOLVM_IMAGE wins over labels", () => {
    process.env.AGENT_CI_SMOLVM_IMAGE = "myorg/custom:1.0";
    const r = resolveSmolvmImage(["ubuntu-22.04"]);
    expect(r.image).toBe("myorg/custom:1.0");
    expect(r.exact).toBe(true);
    expect(r.matchedLabel).toBeNull();
  });

  it("ignores empty AGENT_CI_SMOLVM_IMAGE", () => {
    process.env.AGENT_CI_SMOLVM_IMAGE = "   ";
    const r = resolveSmolvmImage(["ubuntu-22.04"]);
    expect(r.image).toBe(DEFAULT_SMOLVM_IMAGE);
    expect(r.exact).toBe(true);
    expect(r.matchedLabel).toBe("ubuntu-22.04");
  });

  it("matches ubuntu-* labels exactly", () => {
    for (const label of ["ubuntu-22.04", "ubuntu-24.04", "ubuntu-latest", "ubuntu", "linux"]) {
      const r = resolveSmolvmImage([label]);
      expect(r.image).toBe(DEFAULT_SMOLVM_IMAGE);
      expect(r.exact).toBe(true);
      expect(r.matchedLabel).toBe(label);
    }
  });

  it("is case-insensitive on labels", () => {
    const r = resolveSmolvmImage(["Ubuntu-Latest"]);
    expect(r.exact).toBe(true);
    expect(r.matchedLabel).toBe("Ubuntu-Latest");
  });

  it("falls back when no label matches", () => {
    const r = resolveSmolvmImage(["self-hosted", "custom-pool"]);
    expect(r.image).toBe(DEFAULT_SMOLVM_IMAGE);
    expect(r.exact).toBe(false);
    expect(r.matchedLabel).toBe("self-hosted");
  });

  it("prefers a linux-like label as the fallback hint", () => {
    const r = resolveSmolvmImage(["self-hosted", "ubuntu-foo"]);
    expect(r.exact).toBe(false);
    expect(r.matchedLabel).toBe("ubuntu-foo");
  });

  it("handles empty label list", () => {
    const r = resolveSmolvmImage([]);
    expect(r.exact).toBe(false);
    expect(r.matchedLabel).toBeNull();
  });
});
