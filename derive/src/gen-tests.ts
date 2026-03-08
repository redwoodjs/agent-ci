import { execa } from "execa";
import { CLAUDE_BIN, specDir, streamNdjsonProgress } from "./spec.js";

const GEN_TESTS_SYSTEM_PROMPT = `You are a test generation agent. Your job is to generate tests from Gherkin specifications.

Instructions:
1. Read the Gherkin spec files at the path provided in the user prompt.
2. Read existing test files, test utilities, fixtures, and config files (package.json, tsconfig, vitest/jest config, etc.) to understand the project's testing conventions, framework, patterns, and file locations.
3. Generate new tests that exercise the behaviors described in the specs.
4. Write the test files alongside existing tests, following the same conventions.

Constraints:
- Do NOT read implementation source code. You may only read: spec files, test files, test utilities, test fixtures, and project config files. Tests must be black-box — they test the product through its external interfaces (CLI, filesystem, API), not by importing internal modules.
- Follow the same test framework, assertion style, and file organization as existing tests.
- Each test should be independently runnable.
- Use structural assertions (file exists, contains expected content) rather than exact string matching.`;

export async function runGenTests(cwd: string, scope?: string): Promise<void> {
  const dir = specDir(cwd, scope);
  const userPrompt = `Generate tests for the Gherkin specs at ${dir}. Read existing tests to understand conventions.`;

  console.log(`[gen-tests] generating tests from specs at ${dir}`);

  const env = { ...process.env };
  delete env.CLAUDECODE;

  const proc = execa(
    CLAUDE_BIN,
    [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--system-prompt",
      GEN_TESTS_SYSTEM_PROMPT,
      "--no-session-persistence",
      "--model",
      "sonnet",
    ],
    {
      env,
      input: userPrompt,
      extendEnv: false,
      cwd,
      stdout: "pipe",
    },
  );

  streamNdjsonProgress(proc.stdout!);

  await proc;
  process.stderr.write("\n");

  console.log(`[gen-tests] done`);
}
