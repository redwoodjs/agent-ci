# Architecture Blueprint: derive — test generation

> Related blueprints: [derive spec pipeline](derive-spec.md), [derive test infrastructure](derive-test-infra.md)

## 2000ft View Narrative

`derive tests` is a command that spawns an agentic `claude -p` session to generate tests from Gherkin specs. Unlike the spec pipeline (which uses `--tools ""` for stateless text-in/text-out LLM calls), the tests command gives Claude full filesystem tool access so it can read specs, discover existing test conventions, and write test files directly.

The command reads specs from `.agent-ci/specs/[<scope>]/`, lets Claude explore the project's test directory and config files to understand conventions, and Claude writes test files to wherever the project's existing tests live. The generated tests are first-class citizens — reviewed and committed like any other code.

The key constraint is **source code isolation**: Claude must not read implementation source files — only spec files, test files, test utilities, fixtures, and config files. This is enforced via convention-based system prompt instruction rather than path-specific exclusions, because the tests command is designed to work across arbitrary project structures. The constraint is backstopped by human review of generated tests before committing.

## System Flow

```
derive tests [--scope <name>]
  |
  v
main() — detect "tests" subcommand, parse --scope
  |
  v
skip getCurrentBranch(), discoverConversations(), DB access
  (tests operates on spec files, not conversations or git state)
  |
  v
runGenTests(cwd, scope?)
  |
  v
resolve spec dir: <cwd>/.agent-ci/specs/[<scope>]/
  |
  v
construct system prompt:
  - role: test generation agent
  - isolation: read only test files, specs, and config — not implementation source
  - convention discovery: read existing test files to learn patterns
  - output: write test files alongside existing tests
  |
  v
construct user prompt:
  - "Generate tests for the Gherkin specs at <specDir>."
  |
  v
spawn claude -p (agentic — tools enabled, full effort):
  args: -p --verbose --output-format stream-json
        --include-partial-messages --system-prompt "..."
        --no-session-persistence --model sonnet
  env: { ...process.env, delete CLAUDECODE }
  extendEnv: false
  cwd: <repoRoot>
  input: <user prompt> (via stdin)
  |
  v
stream NDJSON to stderr (progress dots, tool use logging)
  |
  v
Claude reads specs, reads existing tests, writes test files
  |
  v
process exits
```

## Behaviour Spec

```gherkin
Feature: Test generation from specs

  Scenario: tests generates test files from spec files
    Given .agent-ci/specs/derive/ contains Gherkin .feature files
    And existing test files exist in the project
    When derive tests --scope derive is run
    Then Claude reads the spec files and existing test conventions
    And Claude writes new test files alongside existing tests
    And the process exits with code 0

  Scenario: tests respects source code isolation
    Given derive tests is run
    When Claude generates tests
    Then Claude does not read implementation source files
    And the generated tests are black-box — no internal imports from source modules

  Scenario: tests uses scope flag to target spec subset
    Given .agent-ci/specs/derive/ contains feature files
    And .agent-ci/specs/other/ contains different feature files
    When derive tests --scope derive is run
    Then only specs from .agent-ci/specs/derive/ are referenced

  Scenario: tests skips conversation discovery
    Given derive tests is run
    Then derive does not call discoverConversations
    And derive does not require CLAUDE_PROJECTS_DIR or a named git branch
```

## Core Architecture

### Command dispatch

`derive tests` is dispatched in `main()` before `getCurrentBranch()` and `discoverConversations()`. It has no dependency on git state, conversation files, or the SQLite database — it operates purely on spec files already on disk.

```typescript
if (args[0] === "tests") {
  await runGenTests(cwd, scope);
  return;
}
```

### Agentic Claude invocation

`derive tests` spawns `claude -p` with tools enabled (no `--tools ""`) and default effort (no `--effort low`). This gives Claude access to filesystem tools (Read, Write, Edit, Glob, Grep) so it can navigate the project, read specs and existing tests, and write test files directly.

Key differences from the spec pipeline's `runClaude`:

| Aspect | `runClaude` (spec pipeline)                      | `runGenTests`                                    |
| ------ | ------------------------------------------------ | ------------------------------------------------ |
| Tools  | `--tools ""` (disabled)                          | Default (all tools enabled)                      |
| Effort | `--effort low`                                   | Default (full effort)                            |
| Input  | Preamble + conversation excerpts piped via stdin | Short user prompt via stdin; Claude reads files  |
| Output | Result text extracted from NDJSON                | Side effects only — Claude writes files directly |
| cwd    | Irrelevant (no filesystem tools)                 | Repo root (so Claude can navigate the project)   |

Shared with the spec pipeline: `--no-session-persistence`, `CLAUDECODE` env var deletion, `extendEnv: false`, `--model sonnet`, NDJSON progress streaming.

### NDJSON progress streaming

`derive tests` reuses the same NDJSON streaming logic as the spec pipeline for progress output. Stream events include tool use events, which are useful for observing what Claude is doing:

```
[claude] tool_use: Read({"file_path":".agent-ci/specs/derive/reset-mode.feature"})
[claude] tool_use: Read({"file_path":"derive/test/e2e/derive-one-shot.test.ts"})
[claude] generating text...
[claude] tool_use: Write({"file_path":"derive/test/e2e/reset-mode.test.ts","content":"..."})
```

The streaming logic is extracted from `runClaude` into a shared helper (`streamNdjsonProgress`) that both `runClaude` and `runGenTests` use.

### Source code isolation

The isolation is a convention-based system prompt instruction — "Do NOT read implementation source code." Defense layers:

1. **System prompt**: convention-based instruction, works across arbitrary project structures
2. **Human review**: generated tests are reviewed before committing — reviewer catches any internal import violations
3. **Black-box test convention**: the spec itself says tests should use external interfaces (CLI, filesystem), reinforcing the pattern Claude sees in existing tests

Hard isolation mechanisms were evaluated and rejected:

- `.claudeignore` is repo-global — it would affect all Claude interactions, not just `derive tests`
- `--disallowed-tools` blocks tools by name, not by path — cannot scope Read to test files only
- Temp dir copy is fragile and slow, defeats organic project structure discovery

### System prompt design

The system prompt has two jobs:

1. **Direct Claude toward the right files**: specs at `<specDir>`, existing tests (Claude discovers where), config files
2. **Fence Claude away from source code**: convention-based instruction — "read only test files, specs, and config; do not read implementation source code"

The instruction is deliberately generic (not tied to specific directory names like `src/` or `lib/`) so it works across arbitrary project structures. Claude infers what counts as "implementation source" vs "test code" from file names, directory conventions, and import patterns.

## API Reference (CLI)

| Command                       | Description                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `derive tests`                | Generate tests from specs in `.agent-ci/specs/`. Claude writes files directly. |
| `derive tests --scope <name>` | Generate tests from specs in `.agent-ci/specs/<name>/` only.                   |

The `--verbose` flag (inherited from the derive CLI) dumps raw NDJSON events from the spawned Claude process.

The `CLAUDE_BIN` env var override works for `derive tests` (same mechanism as the spec pipeline).

## Requirements, Invariants & Constraints

- **No branch dependency.** `derive tests` does not call `getCurrentBranch()` — it works on spec files, not git state. It can run in a detached HEAD state or outside a git repo entirely (as long as spec files exist).
- **No conversation dependency.** `derive tests` does not call `discoverConversations()` — no JSONL reading, no DB access, no `CLAUDE_PROJECTS_DIR` requirement.
- **Recursion prevention.** Same as the spec pipeline: `--no-session-persistence` and `CLAUDECODE` env var deletion.
- **Tools enabled.** `derive tests` must NOT use `--tools ""` — filesystem access is required for the agentic loop.
- **CLAUDE_BIN override.** The env var must work for gen-tests, using the same resolution as the spec pipeline.
- **Convention-based isolation.** The system prompt uses generic instructions (not path-specific) so `derive tests` works across arbitrary project structures.
- **Human review required.** Generated tests are always reviewed before committing. `derive tests` is an on-demand command, not an automated pipeline.

## Learnings & Anti-Patterns

### Convention-based isolation is sufficient for on-demand generation

Hard isolation (tool blocking, temp dir copies) was evaluated and rejected. The spec pipeline needs hard isolation (`--tools ""`) because it runs frequently and automatically. `derive tests` runs on-demand with human review of output, making convention-based system prompt instruction sufficient. Claude's instruction-following is reliable enough that source code reads are rare, and any violations are caught during review.

## Directory Mapping

```
derive/
  src/
    gen-tests.ts        — tests entry point: system prompt, runGenTests function, NDJSON streaming
    index.ts            — CLI entry point: tests dispatch added before getCurrentBranch()
    spec.ts             — shared: CLAUDE_BIN resolution, specDir(), NDJSON streaming helper
```
