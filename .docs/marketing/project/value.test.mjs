import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert";

test("asserts the value is 'pass'", () => {
  const value = readFileSync(new URL("./value.txt", import.meta.url), "utf-8").trim();
  assert.strictEqual(value, "pass", `expected 'pass' but got '${value}'`);
});
