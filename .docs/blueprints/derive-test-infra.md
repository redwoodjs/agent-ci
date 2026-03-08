# Architecture Blueprint: derive test infrastructure

> Related blueprints: [derive spec pipeline](derive-spec.md), [derive test generation](derive-gen-tests.md)

## 2000ft View Narrative

derive's e2e test infrastructure enables full-pipeline testing of the derive CLI without calling Anthropic's API, touching the host filesystem, or spending tokens. Tests spawn derive as a subprocess — the same way a user invokes it — in a fully isolated temp directory environment. Three env var overrides (`CLAUDE_BIN`, `CLAUDE_PROJECTS_DIR`, `MACHINEN_DB`) redirect all I/O to temp paths, and a deterministic substitute binary (`fake-claude-gen-specs`) replaces the real `claude` CLI.

The infrastructure has three layers: the **substitute binaries** (drop-in `claude -p` replacements — one for spec generation that produces deterministic Gherkin, one for test generation that reads spec files and writes test files), the **test harness** (a reusable utility that sets up isolated temp directories, initializes a git repo, writes synthetic JSONL fixtures or pre-populates spec files, spawns derive, and cleans up), and the **e2e tests** that exercise both the spec pipeline and the test generation command. Tests are black-box — they import nothing from derive's source, interact only through the CLI and filesystem.

## System Flow

### Test execution flow

```
setupDeriveTest(opts)
  |
  v
create temp root (mkdtemp)
  |
  +-- projects/                      CLAUDE_PROJECTS_DIR
  |     +-- <slugified-repo-path>/   slug dir (computed from repo path)
  |           +-- <id>.jsonl         synthetic conversation fixture
  |
  +-- repo/                          git-initialized working directory (cwd for derive)
  |
  +-- machinen.db                    MACHINEN_DB (SQLite, created by derive on first run)
  |
  v
return { run(), specDir, repoDir, ... }
  |
  v
run()
  |
  v
execa("tsx", ["derive/src/index.ts"], {
  cwd: tempRepo,
  env: {
    CLAUDE_BIN:         <abs path to fake-claude-gen-specs>,
    CLAUDE_PROJECTS_DIR: tempProjects,
    MACHINEN_DB:        tempDb,
  }
})
  |
  v
derive discovers synthetic conversation → invokes fake-claude-gen-specs → writes .feature files
  |
  v
assertions on filesystem output + exit code
  |
  v
afterEach: rm -rf temp root (automatic via module-level hook)
```

### Substitute binary flow (fake-claude-gen-specs)

```
stdin (preamble + prompt from derive)
  |
  v
parse argv: check -p flag, skip all other flags
  |
  v
extract conversation text:
  - filter to [human]: / [assistant]: prefixed lines
  - fallback to all non-empty lines (handles review pass)
  |
  v
extract keywords:
  - flag tokens via regex (--reset, --scope, etc.)
  - content keywords via keyword-extractor (English stopword removal)
  |
  v
template into Gherkin:
  - one Feature: block ("Extracted specification")
  - one Scenario per flag (named "<flag> flag behavior")
  - one Scenario for grouped content keywords
  - fallback: minimal default Scenario if nothing extracted
  |
  v
stdout: {"type":"result","result":"<gherkin>"}\n
  |
  v
exit 0
```

## Behaviour Spec

```gherkin
Feature: Substitute Claude binary

  Scenario: fake-claude-gen-specs produces NDJSON result from stdin input
    Given fake-claude-gen-specs is invoked with "-p" and stdin containing a prompt
    When the process completes
    Then stdout contains a JSON line with type "result" and a non-empty result string
    And the result string contains valid Gherkin with Feature: and Scenario: blocks
    And the process exits with code 0

  Scenario: fake-claude-gen-specs accepts claude-compatible CLI flags
    Given fake-claude-gen-specs is invoked with flags: -p --verbose --output-format stream-json --model sonnet --tools "" --effort low --no-session-persistence --system-prompt "some prompt"
    When the process completes
    Then the process does not error on unrecognized flags
    And stdout contains a JSON line with type "result"

  Scenario: fake-claude-gen-specs extracts keywords from stdin into Gherkin output
    Given fake-claude-gen-specs is invoked with "-p"
    And stdin contains conversation excerpts mentioning "--reset flag" and "spec regeneration"
    When the process completes
    Then the result Gherkin contains scenarios referencing "reset" and "regeneration"

  Scenario: fake-claude-gen-specs output is deterministic
    Given fake-claude-gen-specs is invoked twice with identical stdin and flags
    When both invocations complete
    Then both produce identical stdout output

  Scenario: fake-claude-gen-specs reads input from stdin
    Given fake-claude-gen-specs is invoked with "-p"
    And "Hello world" is piped to stdin
    When the process completes
    Then the result contains Gherkin derived from the stdin content

Feature: Test harness

  Scenario: setupDeriveTest creates isolated temp directory structure
    Given setupDeriveTest is called with a branch name and conversations
    When setup completes
    Then a temp root directory exists containing projects/, repo/, and machinen.db path
    And the repo/ directory is a git repository on the specified branch
    And conversation JSONL files exist under projects/<slug>/

  Scenario: Slug computation matches Claude Code convention
    Given the temp repo path is "/tmp/derive-test-xxx/repo"
    When the harness computes the slug directory
    Then the slug is "-tmp-derive-test-xxx-repo" (/ and _ replaced with -)
    And the JSONL fixture is written under projects/-tmp-derive-test-xxx-repo/

  Scenario: run() spawns derive with full isolation
    Given setupDeriveTest has been called
    When run() is invoked
    Then derive is spawned as a subprocess with cwd set to the temp repo
    And CLAUDE_BIN points to fake-claude-gen-specs
    And CLAUDE_PROJECTS_DIR points to the temp projects directory
    And MACHINEN_DB points to the temp database path
    And no real ~/.machinen/ or ~/.claude/ paths are accessed

  Scenario: Automatic cleanup after each test
    Given a test has completed (pass or fail)
    When the afterEach hook runs
    Then all temp directories created by setupDeriveTest are removed

Feature: Env var overrides for test isolation

  Scenario: CLAUDE_BIN overrides the claude binary path
    Given CLAUDE_BIN is set to a path
    When derive spawns the claude process
    Then it uses the path from CLAUDE_BIN instead of ~/.local/bin/claude

  Scenario: CLAUDE_PROJECTS_DIR overrides the projects directory
    Given CLAUDE_PROJECTS_DIR is set to a path
    When derive discovers conversations
    Then it reads JSONL files from the overridden path instead of ~/.claude/projects

  Scenario: MACHINEN_DB overrides the database path
    Given MACHINEN_DB is set to a path
    When derive initializes the database
    Then it creates the SQLite database at the overridden path instead of ~/.machinen/machinen.db

  Scenario: Env var overrides are invisible when unset
    Given no test isolation env vars are set
    When derive runs in production
    Then all paths resolve to their hardcoded defaults
    And behavior is identical to before the env var support was added

Feature: E2e test — one-shot spec update

  Scenario: One-shot spec update from a single conversation
    Given a temp directory structure with a synthetic JSONL conversation
    And CLAUDE_BIN points to fake-claude-gen-specs
    And MACHINEN_DB points to a temp file
    And CLAUDE_PROJECTS_DIR points to the temp projects directory
    When derive is run in one-shot mode
    Then derive discovers the conversation
    And derive invokes the stub binary (not the real claude)
    And .machinen/specs/*.feature files are created in the repo directory
    And the .feature files contain valid Gherkin with Feature: and Scenario: blocks
    And the process exits with code 0

Feature: E2e test — test generation

  Scenario: derive tests generates test files from specs
    Given .machinen/specs/derive/ contains Gherkin .feature files
    And CLAUDE_BIN points to fake-claude-gen-tests
    When derive tests --scope derive is run
    Then test files are written to test/generated/ in the repo directory
    And each test file contains vitest structure (describe, it, expect)
    And the process exits with code 0

  Scenario: derive tests generates one test file per feature
    Given .machinen/specs/derive/ contains multiple .feature files
    And CLAUDE_BIN points to fake-claude-gen-tests
    When derive tests --scope derive is run
    Then one test file is generated per feature file
    And test file names match the slugified feature names

  Scenario: derive tests does not require conversations
    Given .machinen/specs/derive/ contains .feature files
    And no synthetic JSONL conversations exist
    And CLAUDE_BIN points to fake-claude-gen-tests
    When derive tests --scope derive is run
    Then the process exits with code 0
```

## Core Architecture

### Substitute binary (`derive/test/scripts/fake-claude-gen-specs`)

A deterministic drop-in replacement for the `claude` CLI, used in e2e tests via the `CLAUDE_BIN` env var override. The binary accepts the same CLI flags and stdin input that derive passes to `claude -p` and emits NDJSON output in the format derive's `runClaude` parser expects. No AI, no model, no network.

The binary is a bash wrapper that invokes a TypeScript source file via tsx:

```
derive/test/scripts/
  fake-claude-gen-specs        bash wrapper (executable)
  fake-claude-gen-specs.mts    TypeScript implementation
```

The bash wrapper resolves tsx from `node_modules/.bin/tsx` relative to the monorepo root (three levels up from the scripts directory).

The `.mts` extension (not `.ts`) is used because some dependencies require ESM module output. tsx defaults to CJS for `.ts` but treats `.mts` as ESM.

#### CLI contract

The binary must accept all flags that derive passes to `claude -p` without erroring:

| Flag                         | Handling                                                 |
| ---------------------------- | -------------------------------------------------------- |
| `-p`                         | Required. Mode gate — binary exits with error if absent. |
| `--system-prompt <string>`   | Accepted, ignored (output is always templated Gherkin).  |
| `--model <name>`             | Accepted, ignored.                                       |
| `--tools <string>`           | Accepted, ignored.                                       |
| `--effort <level>`           | Accepted, ignored.                                       |
| `--verbose`                  | Accepted, ignored.                                       |
| `--output-format <format>`   | Accepted, ignored (always outputs NDJSON).               |
| `--include-partial-messages` | Accepted, ignored.                                       |
| `--no-session-persistence`   | Accepted, ignored.                                       |

#### Keyword extraction strategy

1. Split stdin into lines, filter to `[human]:`/`[assistant]:` prefixed lines (derive's excerpt format). Falls back to all non-empty lines if no conversation-formatted lines are found (handles the review pass, which sends raw Gherkin without conversation prefixes).
2. Extract `--flag` tokens via regex — these become individual Scenario blocks (one per flag).
3. Run remaining text through `keyword-extractor` with `{ language: "english", return_chained_words: true, remove_duplicates: true }` to get meaningful word groups with stopwords removed.
4. Template flags and keywords into a single `Feature: Extracted specification` block with `Given/When/Then` scenarios.
5. Fallback: if no keywords or flags are extracted, produce a minimal valid Feature block with a default Scenario. This guarantees `writeSpec` always has at least one `Feature:` to split.

#### Output format

A single NDJSON line to stdout:

```json
{ "type": "result", "result": "Feature: Extracted specification\n\n  Scenario: ..." }
```

This matches the `result` event format that derive's `runClaude` parser extracts in [spec.ts](derive/src/spec.ts) (the `obj.type === "result"` branch). All diagnostic output goes to stderr.

#### Dependencies

`keyword-extractor` (devDependency in derive's `package.json`). Zero transitive dependencies — it's a stopword list and a split/filter function.

### Substitute binary for test generation (`derive/test/scripts/fake-claude-gen-tests`)

A deterministic drop-in replacement for `claude -p` in agentic mode, used by `derive tests` e2e tests. Unlike `fake-claude-gen-specs` (which returns Gherkin via NDJSON result), this binary simulates agentic behavior: it reads spec files from disk, generates deterministic test files, and writes them to disk. The primary output is **side effects** (test files), not the NDJSON result.

The binary reads the spec directory path from the stdin prompt (which `runGenTests` constructs as `"Generate tests for the Gherkin specs at <path>. ..."`), reads all `.feature` files from that directory, generates one vitest test file per feature (with `describe`/`it`/`expect` structure), and writes them to `<cwd>/test/generated/<feature-slug>.test.ts`.

Same bash wrapper + `.mts` TypeScript pattern as `fake-claude-gen-specs`. Same CLI flag acceptance contract. Zero external dependencies (no `keyword-extractor` — just `node:fs` and `node:path`).

### Env var overrides

Three one-line changes in derive's production code make hardcoded paths configurable:

| Env var               | Source file                     | Default                   | Purpose                      |
| --------------------- | ------------------------------- | ------------------------- | ---------------------------- |
| `CLAUDE_BIN`          | [spec.ts](derive/src/spec.ts)   | `~/.local/bin/claude`     | Path to the `claude` binary  |
| `CLAUDE_PROJECTS_DIR` | [index.ts](derive/src/index.ts) | `~/.claude/projects`      | Conversation JSONL directory |
| `MACHINEN_DB`         | [db.ts](derive/src/db.ts)       | `~/.machinen/machinen.db` | SQLite database path         |

Each uses `process.env.X ?? <default>`. When unset, behavior is identical to the hardcoded paths — zero behavioral change in production. These exist solely for test isolation.

### Test harness (`derive/test/e2e/harness.ts`)

A reusable utility that encapsulates temp directory setup, git initialization, slug computation, JSONL fixture writing, derive invocation, and cleanup.

#### API

```typescript
interface HarnessOptions {
  branch?: string; // default: "test-branch"
  conversations?: Array<{
    id?: string; // default: random UUID
    messages: Array<{
      type: "user" | "assistant";
      content: string;
    }>;
  }>;
  specs?: {
    scope?: string; // subdirectory under .machinen/specs/
    features: Array<{
      name: string; // filename (e.g. "reset-mode.feature")
      content: string; // raw Gherkin content
    }>;
  };
  claudeBin?: string; // override fake binary (default: fake-claude-gen-specs)
  deriveArgs?: string[]; // extra args (e.g. "--reset", "--scope foo", "tests")
}

interface HarnessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  specDir: string; // path to .machinen/specs/ in the temp repo
  repoDir: string; // path to the temp repo
  featureFiles: string[]; // list of .feature file paths
}
```

`setupDeriveTest(opts)` returns `{ run, specDir, repoDir }` where `run()` spawns derive and returns `HarnessResult`.

#### Temp directory layout

```
$TMPDIR/derive-test-XXXXX/
  projects/                          CLAUDE_PROJECTS_DIR
    -tmp-derive-test-xxxxx-repo/     slugified repo path
      <uuid>.jsonl                   synthetic conversation fixture
  repo/                              git-initialized working directory
  machinen.db                        MACHINEN_DB (created by derive on first run)
```

#### Slug computation

The harness computes the slug from the temp repo path using the same algorithm as derive's `getSlugDir`: `repoPath.replace(/[/_]/g, "-")`. This ensures the synthetic JSONL files are placed where derive will look for them.

#### Git initialization

The temp repo is `git init`'d with a named branch and an initial empty commit (so HEAD exists and `git rev-parse --abbrev-ref HEAD` works). This satisfies derive's branch detection without any production code changes.

#### Synthetic JSONL fixture format

Each conversation is a `.jsonl` file where each line is a JSON object:

```jsonl
{"type":"user","sessionId":"<uuid>","cwd":"<temp-repo-path>","gitBranch":"<branch>","message":{"role":"user","content":"<text>"}}
{"type":"assistant","sessionId":"<uuid>","cwd":"<temp-repo-path>","gitBranch":"<branch>","message":{"role":"assistant","content":"<text>"}}
```

The `cwd` and `gitBranch` fields must match the temp repo path and branch name — derive uses these for routing during discovery. The `sessionId` is consistent within a conversation file.

#### Cleanup

Module-level side effect: the harness maintains a `Set<string>` of temp root paths. Each `setupDeriveTest` call adds its temp root. An `afterEach` hook (registered on import) iterates the set, removes each directory recursively, and clears the set. Tests never think about cleanup.

```typescript
const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});
```

### Test conventions

- Tests are fully black-box: no imports from derive's `src/` — only subprocess invocation and filesystem assertions.
- Test files live in `derive/test/e2e/` with `.test.ts` extension.
- Each test uses `setupDeriveTest()` from the harness — no manual temp dir management.
- Assertions target structural properties: exit code, file existence, `Feature:` and `Scenario:` presence. Not content quality.
- The test suite runs via `pnpm --filter derive test` (vitest).
- Tests are sequential (no parallelism) since they involve filesystem state.

## API Reference (CLI)

### fake-claude-gen-specs

```
derive/test/scripts/fake-claude-gen-specs -p [options]

Reads a prompt from stdin, extracts keywords, outputs deterministic Gherkin as NDJSON to stdout.

Options (accepted for compatibility, all ignored):
  -p                          Required. Enables prompt mode (reads stdin).
  --system-prompt <string>    Accepted, ignored.
  --model <name>              Accepted, ignored.
  --tools <string>            Accepted, ignored.
  --effort <level>            Accepted, ignored.
  --verbose                   Accepted, ignored.
  --output-format <format>    Accepted, ignored.
  --include-partial-messages  Accepted, ignored.
  --no-session-persistence    Accepted, ignored.

Stdin:  The full prompt text (preamble + user prompt concatenated).
Stdout: One NDJSON line: {"type":"result","result":"<gherkin>"}
Exit:   0 on success, non-zero on failure.
```

## Requirements, Invariants & Constraints

- **Full isolation.** Tests must not touch `~/.machinen/`, `~/.claude/`, or `~/.local/bin/claude`. All paths are redirected via env vars.
- **No network.** The substitute binary makes no network calls. No model downloads, no API calls.
- **Deterministic output.** Identical stdin to `fake-claude-gen-specs` produces identical stdout. No randomness, no timestamps in output.
- **At least one Feature block.** The substitute binary always produces at least one `Feature:` block in its output, ensuring `writeSpec` creates at least one `.feature` file.
- **NDJSON compatibility.** The substitute binary's output must be parseable by derive's `runClaude` parser — specifically the `obj.type === "result"` branch that extracts `obj.result`.
- **Flag tolerance.** The substitute binary must accept all CLI flags that derive passes to `claude -p` without erroring, even though it ignores all of them except `-p`.
- **Automatic cleanup.** Temp directories are removed after each test via the harness's `afterEach` hook. Tests never leak temp dirs.
- **Black-box only.** Tests do not import derive's internal modules. They interact with derive through subprocess invocation and filesystem inspection.
- **Env var overrides are invisible when unset.** Production behavior is unchanged unless the env var is explicitly set.
- **Slug fidelity.** The harness computes slugs using the same `replace(/[/_]/g, "-")` algorithm as derive, ensuring synthetic JSONL files land where derive's `getSlugDir` looks.

## Learnings & Anti-Patterns

### Local AI models are unnecessary for pipeline testing

The original approach used `node-llama-cpp` with tiny GGUF models (SmolLM-135M, Qwen3-0.6B) as the substitute binary's backend. SmolLM-135M produced gibberish (Emacs Lisp in a loop). Qwen3-0.6B produced coherent English but couldn't reliably follow Gherkin format instructions without few-shot examples and post-processing hacks (`ensureGherkinStructure`). The realization: the test's job is to verify derive's pipeline, not AI output quality. A deterministic keyword-to-Gherkin template produces structurally valid output with zero flakiness, zero download friction, and zero cost.

### The .mts extension is required for ESM compatibility

tsx defaults to CJS output for `.ts` files but treats `.mts` as ESM. When dependencies use top-level await or ESM-only features, the source file must use `.mts` to ensure tsx emits ESM module output.

### Slug computation must match Claude Code exactly

Claude Code replaces both `/` and `_` with `-` when computing slug directories. The test harness must use the same algorithm (`path.replace(/[/_]/g, "-")`), or synthetic JSONL files will be placed in a directory that derive's `getSlugDir` never looks at. This was a known pitfall from derive's own development.

### The review pass sends raw Gherkin without conversation prefixes

derive's spec pipeline has two passes: extraction (which sends `[human]:`/`[assistant]:` prefixed excerpts) and review (which sends raw Gherkin). The substitute binary must handle both input formats. It filters for conversation-prefixed lines first and falls back to all non-empty lines when none are found.

## Directory Mapping

```
derive/
  test/
    scripts/
      fake-claude-gen-specs          bash wrapper (executable, invokes tsx)
      fake-claude-gen-specs.mts      keyword extraction + Gherkin templating (spec pipeline stub)
      fake-claude-gen-tests          bash wrapper (executable, invokes tsx)
      fake-claude-gen-tests.mts      reads specs, writes test files (test generation stub)
    e2e/
      harness.ts                     reusable test setup/teardown/run utility
      derive-one-shot.test.ts        e2e test: synthetic JSONL -> fake-claude -> .feature output
      derive-tests.test.ts           e2e test: pre-populated specs -> fake-claude -> test file output
  src/
    spec.ts                          CLAUDE_BIN env var override, shared NDJSON streaming helper
    index.ts                         CLAUDE_PROJECTS_DIR env var override, tests dispatch
    gen-tests.ts                     test generation command (runGenTests)
    db.ts                            MACHINEN_DB env var override
  package.json                       "test" script, keyword-extractor devDependency
```
