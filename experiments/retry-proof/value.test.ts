import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("retry proof", () => {
  it("asserts the value is 'pass'", () => {
    const value = readFileSync(new URL("./value.txt", import.meta.url), "utf-8").trim();
    expect(value).toBe("pass");
  });
});
