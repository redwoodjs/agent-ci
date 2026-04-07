import { describe, it, expect } from "vitest";

import { evaluate, interpolate, evaluateCondition, type ExpressionContext } from "./expressions.js";

function makeCtx(overrides: Partial<ExpressionContext> = {}): ExpressionContext {
  return {
    github: {
      actor: "octocat",
      ref: "refs/heads/main",
      ref_name: "main",
      sha: "abc123",
      run_id: "42",
    },
    env: { NODE_ENV: "test", CI: "true" },
    secrets: { DEPLOY_KEY: "secret123" },
    matrix: { os: "ubuntu-latest", node: "20" },
    steps: {
      build: { outputs: { artifact: "dist.tar.gz" }, outcome: "success", conclusion: "success" },
      test: { outputs: {}, outcome: "failure", conclusion: "failure" },
    },
    needs: {
      setup: { outputs: { cache_key: "v1-abc" }, result: "success" },
    },
    runner: {
      os: "Linux",
      arch: "X64",
      name: "ts-runner",
      temp: "/tmp",
      tool_cache: "/tmp/tool-cache",
    },
    job: { status: "success" },
    inputs: { environment: "staging" },
    ...overrides,
  };
}

describe("evaluate", () => {
  describe("literals", () => {
    it("evaluates string literals", () => {
      expect(evaluate("'hello'", makeCtx())).toBe("hello");
    });

    it("evaluates number literals", () => {
      expect(evaluate("42", makeCtx())).toBe(42);
    });

    it("evaluates boolean literals", () => {
      expect(evaluate("true", makeCtx())).toBe(true);
      expect(evaluate("false", makeCtx())).toBe(false);
    });

    it("evaluates null", () => {
      expect(evaluate("null", makeCtx())).toBe(null);
    });
  });

  describe("context access", () => {
    it("reads github context", () => {
      expect(evaluate("github.actor", makeCtx())).toBe("octocat");
    });

    it("reads env context", () => {
      expect(evaluate("env.NODE_ENV", makeCtx())).toBe("test");
    });

    it("reads secrets", () => {
      expect(evaluate("secrets.DEPLOY_KEY", makeCtx())).toBe("secret123");
    });

    it("reads matrix values", () => {
      expect(evaluate("matrix.os", makeCtx())).toBe("ubuntu-latest");
    });

    it("reads step outputs", () => {
      expect(evaluate("steps.build.outputs.artifact", makeCtx())).toBe("dist.tar.gz");
    });

    it("reads step outcome", () => {
      expect(evaluate("steps.build.outcome", makeCtx())).toBe("success");
    });

    it("reads needs outputs", () => {
      expect(evaluate("needs.setup.outputs.cache_key", makeCtx())).toBe("v1-abc");
    });

    it("reads needs result", () => {
      expect(evaluate("needs.setup.result", makeCtx())).toBe("success");
    });

    it("returns empty string for missing context", () => {
      expect(evaluate("github.nonexistent", makeCtx())).toBe("");
    });

    it("reads runner context", () => {
      expect(evaluate("runner.os", makeCtx())).toBe("Linux");
    });

    it("reads inputs", () => {
      expect(evaluate("inputs.environment", makeCtx())).toBe("staging");
    });
  });

  describe("comparisons", () => {
    it("evaluates ==", () => {
      expect(evaluate("github.actor == 'octocat'", makeCtx())).toBe(true);
      expect(evaluate("github.actor == 'other'", makeCtx())).toBe(false);
    });

    it("evaluates != ", () => {
      expect(evaluate("github.actor != 'other'", makeCtx())).toBe(true);
    });

    it("string comparison is case-insensitive", () => {
      expect(evaluate("'ABC' == 'abc'", makeCtx())).toBe(true);
    });

    it("number comparison", () => {
      expect(evaluate("1 == 1", makeCtx())).toBe(true);
      expect(evaluate("1 < 2", makeCtx())).toBe(true);
      expect(evaluate("2 > 1", makeCtx())).toBe(true);
      expect(evaluate("1 <= 1", makeCtx())).toBe(true);
      expect(evaluate("1 >= 1", makeCtx())).toBe(true);
    });
  });

  describe("logical operators", () => {
    it("evaluates &&", () => {
      expect(evaluate("true && true", makeCtx())).toBe(true);
      expect(evaluate("true && false", makeCtx())).toBe(false);
    });

    it("evaluates ||", () => {
      expect(evaluate("false || true", makeCtx())).toBe(true);
      expect(evaluate("false || false", makeCtx())).toBe(false);
    });

    it("evaluates !", () => {
      expect(evaluate("!true", makeCtx())).toBe(false);
      expect(evaluate("!false", makeCtx())).toBe(true);
    });

    it("short-circuits &&", () => {
      // false && anything => false (returns left operand)
      expect(evaluate("false && true", makeCtx())).toBe(false);
    });

    it("short-circuits ||", () => {
      // true || anything => true (returns left operand)
      expect(evaluate("true || false", makeCtx())).toBe(true);
    });
  });

  describe("functions", () => {
    it("success() returns true when all steps succeeded", () => {
      const ctx = makeCtx({
        steps: {
          a: { outputs: {}, outcome: "success", conclusion: "success" },
        },
      });
      expect(evaluate("success()", ctx)).toBe(true);
    });

    it("failure() returns true when a step failed", () => {
      const ctx = makeCtx(); // has a "test" step with failure
      expect(evaluate("failure()", ctx)).toBe(true);
    });

    it("always() returns true", () => {
      expect(evaluate("always()", makeCtx())).toBe(true);
    });

    it("contains() with string", () => {
      expect(evaluate("contains('hello world', 'world')", makeCtx())).toBe(true);
      expect(evaluate("contains('hello world', 'xyz')", makeCtx())).toBe(false);
    });

    it("contains() is case-insensitive", () => {
      expect(evaluate("contains('Hello', 'hello')", makeCtx())).toBe(true);
    });

    it("startsWith()", () => {
      expect(evaluate("startsWith('hello world', 'hello')", makeCtx())).toBe(true);
      expect(evaluate("startsWith('hello world', 'world')", makeCtx())).toBe(false);
    });

    it("endsWith()", () => {
      expect(evaluate("endsWith('hello world', 'world')", makeCtx())).toBe(true);
    });

    it("format()", () => {
      expect(evaluate("format('Hello {0}, {1}!', 'world', 'test')", makeCtx())).toBe(
        "Hello world, test!",
      );
    });

    it("join()", () => {
      // join with a context value that is an array would be tested with arrays
      // For now, test with a string (returns the string as-is)
      expect(evaluate("join('hello', '-')", makeCtx())).toBe("hello");
    });

    it("toJSON()", () => {
      expect(evaluate("toJSON('hello')", makeCtx())).toBe('"hello"');
    });

    it("fromJSON()", () => {
      expect(evaluate("fromJSON('42')", makeCtx())).toBe(42);
      expect(evaluate("fromJSON('true')", makeCtx())).toBe(true);
    });
  });

  describe("complex expressions", () => {
    it("nested function calls in comparisons", () => {
      expect(
        evaluate("contains(github.ref_name, 'main') && github.actor == 'octocat'", makeCtx()),
      ).toBe(true);
    });

    it("parenthesized expressions", () => {
      expect(evaluate("(true || false) && true", makeCtx())).toBe(true);
    });

    it("negated comparison", () => {
      expect(evaluate("!(github.actor == 'other')", makeCtx())).toBe(true);
    });
  });
});

describe("interpolate", () => {
  it("interpolates expressions in strings", () => {
    expect(interpolate("Hello ${{ github.actor }}!", makeCtx())).toBe("Hello octocat!");
  });

  it("handles multiple expressions", () => {
    expect(interpolate("${{ matrix.os }}-${{ matrix.node }}", makeCtx())).toBe("ubuntu-latest-20");
  });

  it("preserves non-expression text", () => {
    expect(interpolate("no expressions here", makeCtx())).toBe("no expressions here");
  });

  it("returns empty string for unknown contexts", () => {
    expect(interpolate("${{ unknown.thing }}", makeCtx())).toBe("");
  });
});

describe("evaluateCondition", () => {
  it("defaults to success() when empty", () => {
    const ctx = makeCtx({
      steps: { a: { outputs: {}, outcome: "success", conclusion: "success" } },
    });
    expect(evaluateCondition("", ctx)).toBe(true);
  });

  it("strips ${{ }} wrapper", () => {
    expect(evaluateCondition("${{ true }}", makeCtx())).toBe(true);
  });

  it("evaluates failure()", () => {
    expect(evaluateCondition("failure()", makeCtx())).toBe(true);
  });

  it("evaluates always()", () => {
    expect(evaluateCondition("always()", makeCtx())).toBe(true);
  });

  it("evaluates context comparison", () => {
    expect(evaluateCondition("github.actor == 'octocat'", makeCtx())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression tests for bug fixes (#133)
// ---------------------------------------------------------------------------

describe("bug fixes", () => {
  it("parses escaped single quotes in string literals", () => {
    const ctx = makeCtx();
    // 'it''s' should parse as the string "it's"
    expect(evaluate("'it''s'", ctx)).toBe("it's");
    expect(evaluate("'don''t stop'", ctx)).toBe("don't stop");
    // Empty escaped quote: '''' = single quote
    expect(evaluate("''''", ctx)).toBe("'");
  });

  it("treats string '0' and 'false' as truthy", () => {
    const ctx = makeCtx({ env: { ...makeCtx().env, ZERO: "0", FALSE: "false" } });
    // In GitHub Actions, non-empty strings are truthy
    expect(evaluate("env.ZERO && 'yes'", ctx)).toBe("yes");
    expect(evaluate("env.FALSE && 'yes'", ctx)).toBe("yes");
    // Empty string is still falsy
    expect(evaluate("'' && 'yes'", ctx)).toBe("");
  });

  it("simpleMatch escapes regex metacharacters in glob patterns", () => {
    // hashFiles uses simpleMatch internally — test via evaluate
    // The key thing is that patterns with regex metacharacters don't crash
    const ctx = makeCtx({ workspace: "/nonexistent" });
    // This should not throw (previously would crash on unbalanced brackets)
    expect(() => evaluate("hashFiles('src/file[1].txt')", ctx)).not.toThrow();
    expect(() => evaluate("hashFiles('src/c++/main.cpp')", ctx)).not.toThrow();
  });
});
