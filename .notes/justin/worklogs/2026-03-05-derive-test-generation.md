# derive test generation — design and first manual e2e test

## Task Narrative

We need to design and implement test generation for derive, where tests are generated from the Gherkin specs that derive itself produces. The work has two phases: (1) manually write one e2e test to establish infrastructure and conventions, then (2) build a mechanism for derive to auto-generate tests from specs. This is a dogfooding opportunity — derive already generates specs for itself, and now those specs become the input for test generation.

Beyond the immediate task, this fits into a larger pipeline vision: conversation changes trigger spec updates, spec updates trigger test generation, and test runs are executed via the local CI runner (supervisor) that already exists in the monorepo. The user interaction model matters — specs should be reviewed/edited by a human before tests proceed.

## Synthesized Context

### From `.docs/blueprints/derive.md`

- derive is a CLI that extracts Gherkin specs from Claude Code conversations
- Spec pipeline: two-pass (extraction + review) via `claude -p` with `--model sonnet --tools "" --effort low`
- Spec I/O is virtualized: `readSpec` concatenates `.feature` files, `writeSpec` splits by `Feature:` block
- Modes: one-shot (`derive`), reset (`derive --reset`), watch (`derive watch`)
- Specs live at `<repoPath>/.machinen/specs/` (or `<repoPath>/.machinen/specs/<scope>/`)
- Key invariant: spec pipeline is stateless — each call reads spec from disk, produces updated version
- Claude recursion prevention: `extendEnv: false`, `delete env.CLAUDECODE`
- No session persistence to avoid ghost conversations

### From `.docs/learnings/claude-code-slugification.md`

- Claude Code replaces both `/` and `_` with `-` when computing slug directories
- Relevant for any test that constructs or validates slug directory paths

### From codebase exploration

- **Zero test infrastructure exists in derive today.** No vitest config, no test script, no test files
- Monorepo uses vitest throughout (supervisor, dtu-github-actions)
- Existing test style: `describe`/`it`/`expect`, real `fs.mkdtempSync` temp dirs, `afterEach` cleanup, no mocking — pure function calls with real filesystem I/O
- 10 `.feature` files with 29 scenarios covering: CLI context detection, conversation discovery, incremental updates, multi-file storage, one-shot update, reset mode, scope flag, spec content/format, spec file location, watch mode
- TypeScript uses `module: NodeNext` with `.js` extensions on imports
- The monorepo has a local CI runner (`supervisor` + `dtu-github-actions`) that can execute tests locally using GitHub CI workflow config

### Pipeline vision (from user)

- Manual mode: `derive` runs -> specs generated -> human reviews/edits -> tests auto-generated -> local CI runs tests
- Watch mode: conversation changes -> specs updated -> tests updated -> local CI runs tests
- Opt-out flags for test generation in both modes
- Possible standalone "update tests only" mode
- Key restriction: test generation must NOT have access to derive's source code — only the test code itself and the specs. This enforces black-box testing at the implementation level, not just the spec level

## Known Unknowns

1. **What does a good first manual e2e test look like for derive?** Which scenario is the best starting point — simple enough to establish infra, complex enough to validate the approach?
2. **How do we prevent `claude -p` from reading source code during test generation?** Options: `--disallowed-tools`, working directory isolation, `.claudeignore`, or feeding only spec + test files via stdin?
3. **How does the test generation pipeline integrate with derive's existing modes?** Is it a separate command (`derive tests`), a flag (`--gen-tests`), or automatic post-spec behavior?
4. **What's the boundary between derive's responsibility and the supervisor's?** derive generates tests, supervisor runs them — but who triggers the supervisor?
5. **How do we handle the human review step?** Is it just "specs exist on disk, user reviews via git diff" or is there a more structured workflow?
6. **What conventions should the generated tests follow?** The first manual test establishes these — vitest style, temp dir fixtures, what gets mocked vs real?
7. **Where do generated tests live?** In `derive/src/__tests__/`? In a separate `derive/test/` dir? Next to the specs?
8. **How do we get real AI in tests without cost risk?** See discussion below.

## Design discussion: the pipeline vision

The overall pipeline that's emerging:

```
conversations -> [derive] -> specs -> [human review] -> [test gen] -> tests -> [supervisor] -> results
```

Each stage watches its input:

- **derive watch**: watches JSONL conversation files, outputs specs
- **test gen watch**: watches `.feature` spec files, outputs test files
- **supervisor**: watches test files (or is triggered), runs tests locally

### Integration with derive's existing modes

Several options discussed:

- `derive` (one-shot) -> update specs -> optionally auto-generate tests (default on, `--no-tests` to skip)
- `derive watch` -> watch conversations -> update specs -> update tests (default on, `--no-tests` to skip)
- `derive tests` (or `derive --tests-only`) -> standalone mode, watches specs or does one-shot test gen
- Human review fits between spec update and test gen — in manual mode, the user reviews the spec diff before tests proceed

The watch mode for tests watches a different input than spec watch. Spec watch monitors JSONL conversation files. Test watch monitors `.feature` spec files. Both could be combined under `derive watch` or kept separate.

### Source code isolation for test generation

Key restriction: the test generation `claude -p` call must NOT have access to derive's source code. It should only see the specs and existing test code. This enforces black-box testing at the implementation level.

Options explored:

- **stdin-only approach** (preferred): same pattern as the spec pipeline. Feed specs + existing test code via stdin, use `--tools ""` to disable all tools. No filesystem access at all. Most consistent with existing architecture.
- **Working directory isolation**: run `claude -p` from a temp dir containing only specs and test files.
- **`--disallowed-tools`**: explicitly block file-reading tools.

stdin-only is the strongest guarantee and matches how `runClaude` already works.

### First manual e2e test — candidate scenarios

Best candidate: **"Multi-file spec storage: Spec output is split into per-feature files"**. Exercises `writeSpec` and `readSpec` — pure filesystem operations, no `claude -p` dependency, clear inputs/outputs. Establishes infra and conventions that every subsequent test builds on.

Alternative: **"CLI context detection: Detached HEAD is rejected"** — even simpler (spawn derive in a temp git repo with detached HEAD, assert non-zero exit + error message) but tests less of the internal machinery.

## Design discussion: AI in tests — the cost risk problem

### The tension

Many spec scenarios describe behaviors that involve LLM output (spec extraction and review passes). We want tests that exercise the real pipeline, not fixture substitution. But real LLM calls in tests create problems:

1. **Runaway cost risk.** This is the primary concern. A bug in a test runner, a watch mode gone haywire, a retry loop — any of these could spin up hundreds of `claude -p` calls. This risk is especially acute in this monorepo because it contains the supervisor (local CI runner) tooling itself. A feedback loop between the test watcher, the supervisor, and the test generator could compound rapidly. The ghost conversation problem documented in the blueprint (where `claude -p` session files created a feedback loop) is a concrete precedent for exactly this kind of runaway behavior.
2. **Non-determinism.** LLM output varies between runs. Tests must assert on structural properties (valid Gherkin, correct file names, feature blocks present) rather than exact content.
3. **Credential requirements.** Every test environment needs an Anthropic API key or Claude subscription. CI needs secrets. New contributors need accounts.
4. **Speed.** Even haiku at `--effort low` on tiny inputs adds seconds per test. In a large test suite or watch loop, this adds up.

### Options explored

**Option A: Test at the I/O boundary, skip AI entirely.** Most scenarios don't need to verify what the LLM produces — they verify what derive does with the output. `writeSpec`, `readSpec`, slug computation, DB operations, offset tracking — all pure I/O. The LLM is treated as an opaque transformation. Pro: fast, free, deterministic. Con: doesn't test the actual pipeline end-to-end.

**Option B: Fixture substitution via dependency injection.** Pre-record LLM output as fixture files. Inject a fake `claudeRunner` instead of real `runClaude`. Pro: deterministic, fast, no cost. Con: we explicitly don't want this — "fixture substitution is yucky, gotta be the real thing."

**Option C: Real AI on synthetic inputs.** Use tiny hand-crafted JSONL conversations (3-4 messages), run through real `claude -p` with `--model haiku --effort low`. Assert on structural output properties. Pro: tests the real pipeline. Con: still costs money (even if tiny per-run), still needs credentials, and critically — still vulnerable to runaway loops multiplying even tiny costs.

**Option D: Free AI alternative.** The ideal: real AI behavior with zero cost risk. Open question — does such a thing exist in our tooling ecosystem?

### Where we are

Option A is necessary regardless — the pure I/O scenarios should be fast, free tests. The question is what to do about the scenarios that exercise the full pipeline. We're looking for a way to get real AI processing without the runaway cost risk. This remains an open question.

Avenues to explore:

- Local models (ollama etc.) — but `claude` CLI doesn't support arbitrary backends
- Some free tier or test mode in the Claude ecosystem?
- A way to put a hard ceiling on API spend (budget caps, token limits)?
- Structural approach: make the AI call a pluggable seam, default to real AI, but with circuit-breaker / rate-limiting / budget controls that prevent runaways?
- 1-bit models (BitNet) — drastically smaller on disk, faster on CPU

### Reframing: the bar for "real AI" in tests

Key realization: the AI in tests doesn't need to be _good_. It needs to produce _valid structured output_ — text that starts with `Feature:`, has `Scenario:` blocks, follows Gherkin syntax. The test assertions are structural (files split correctly, slugs match, offsets advance), not qualitative (are the scenarios insightful?). Even a tiny, dumb model that can follow format instructions is sufficient. This lowers the bar dramatically and makes local models viable.

A side benefit: if a small model occasionally produces wonky output, that's a legitimate test of derive's resilience to imperfect LLM output.

### Investigation: local model options

**Ollama** — `brew install ollama && ollama pull <model>`. Easy but requires a daemon process, a multi-GB model download, and CI infrastructure (install + cache). Not zero-click.

**Llamafile (Mozilla)** — single-binary LLM (model weights baked into executable). Download one file, `chmod +x`, run. Genuinely portable. But the binary itself is 2GB+ even for TinyLlama. Same download problem, differently packaged. Source: https://github.com/mozilla-ai/llamafile

**node-llama-cpp** — npm package (`pnpm add node-llama-cpp`). Pre-built native binaries for macOS/Linux/Windows, no node-gyp or Python needed. Runs GGUF models in-process from Node.js. Still needs a separate model file download. Source: https://github.com/withcatai/node-llama-cpp

**BitNet (Microsoft)** — 1-bit LLMs where weights are ternary {-1, 0, +1}. The 2B parameter model (`bitnet-b1.58-2B-4T`) is ~1.2GB on disk as GGUF — roughly 6x smaller than an equivalent full-precision model. Runs 2-6x faster on CPU than full-precision peers. Uses bitnet.cpp (a fork of llama.cpp) for inference. Source: https://github.com/microsoft/BitNet

**Tiny standard models** — Qwen2.5-0.5B (~300-400MB quantized), SmolLM2-1.7B, TinyLlama-1.1B. These run via node-llama-cpp or ollama.

### Compatibility assessment

**BitNet + node-llama-cpp**: NOT currently compatible. BitNet's GGUF files use `i2_s` quantization format that requires bitnet.cpp's specialized kernels. Standard llama.cpp (and therefore node-llama-cpp) cannot load them. A HuggingFace discussion explicitly confirms "GGUF not llama.cpp compatible yet." Source: https://huggingface.co/microsoft/bitnet-b1.58-2B-4T-gguf/discussions/2

**BitNet standalone**: bitnet.cpp is C++/Python only. No Node.js bindings. We'd need to spawn it as a child process (similar to how we spawn `claude -p` today). This is feasible but adds build complexity (CMake, Clang 18+).

**node-llama-cpp + tiny standard model**: This is the most viable path for Node.js integration. `pnpm add node-llama-cpp`, download a ~300-400MB Qwen2.5-0.5B GGUF, call it in-process. The model download is a one-time cost, cacheable.

### Current assessment

The most practical path for local AI in tests:

| Approach                          | Model size | Install friction            | CI friction           | Node.js integration       |
| --------------------------------- | ---------- | --------------------------- | --------------------- | ------------------------- |
| node-llama-cpp + Qwen2.5-0.5B     | ~400MB     | `pnpm add` + model download | cache model file      | native (in-process)       |
| node-llama-cpp + TinyLlama-1.1B   | ~600MB     | `pnpm add` + model download | cache model file      | native (in-process)       |
| BitNet b1.58 2B via child process | ~1.2GB     | clone + CMake build         | build from source     | child process (execa)     |
| ollama + tiny model               | ~400MB     | brew install + pull         | install ollama + pull | HTTP API or child process |

node-llama-cpp with a tiny model is the least-friction option that stays in-process in Node.js. The model download (~400MB) is the main friction point — needs a one-time download step and CI caching.

BitNet is promising for the future (1.2GB for a 2B model is impressive) but the tooling isn't ready — no llama.cpp compat, no Node.js bindings. Worth revisiting as the ecosystem matures.

### Open: implementation seam design

Regardless of which local model we use, derive needs a pluggable seam where `runClaude` can be swapped for `runLocalModel` in tests. The seam would accept (systemPrompt, userPrompt) and return a string. Options:

- Function parameter injection: `updateSpec(messages, dir, { runner: localModelRunner })`
- Environment variable: `DERIVE_MODEL_BACKEND=local` switches the runner
- Separate test entry point that wires up the local runner

The function parameter approach is cleanest — no global state, explicit dependency, testable in isolation. It's also consistent with the "prefer dependency injection over mocking" convention from CLAUDE.md.

### Investigation: how small can we actually go?

**SmolLM-135M** (HuggingFace) — a 135 million parameter model. GGUF quantized sizes:

- Q2_K: **88MB**
- Q4_K_M: **105MB**
- Q8_0: **145MB**

Source: https://huggingface.co/QuantFactory/SmolLM-135M-GGUF

That's an 88MB model file. Comparable to a medium npm dependency. There's also SmolLM-360M and an Instruct variant (SmolLM-135M-Instruct) that's fine-tuned for following instructions.

**Qwen3-0.6B** — 600M params. GGUF sizes:

- Q2_K: **296MB**
- Q4_K_M: **397MB**

Bigger but significantly more capable.

**The quality question**: the oobabooga benchmark (https://oobabooga.github.io/benchmark.html) tests 868 models on reasoning tasks. At the sub-1B scale, reasoning scores are very low (1-3/48 for Phi-3-mini at 1GB). But we don't need reasoning. We need format-following — "output text in Gherkin format." That's a much lower bar than logic puzzles.

The SmolLM-135M-Instruct variant is specifically designed to follow instructions, though it's English-only and struggles with complex reasoning. For "produce text that looks like Gherkin" it might be enough. At 88MB it's essentially free in terms of download friction.

**Risk**: a 135M model might be too small to reliably produce structured Gherkin. It could output something that looks like natural language but doesn't follow the Given/When/Then structure consistently. This needs a spike to validate.

**Fallback ladder**: if 135M is too dumb, step up to 360M (~150MB), then Qwen3-0.6B (~300MB). We'd find the minimum viable model size empirically.

### Reference: awesome-local-llm

Surveyed https://github.com/rafska/awesome-local-llm — a curated list of local LLM tools, runtimes, and benchmarks. No fundamentally new approaches beyond what we've already investigated. The landscape is: runtime engines (ollama, llama.cpp, llamafile, LM Studio, LocalAI, koboldcpp), tiny model families (Phi-4, SmolLM, Qwen, Ministral), and benchmarks (oobabooga, Dubesor, Arena). The node-llama-cpp + tiny GGUF model path remains the lowest-friction option for our Node.js test harness.

### Revised approach: substitute binary (drop-in `claude` replacement)

Instead of injecting a seam into derive's internals, we build a **substitute binary** — a Node script that mimics `claude -p`'s CLI signature and output format, backed by a local model via node-llama-cpp. derive doesn't change at all. Tests just point at a different binary.

This is architecturally cleaner than dependency injection because:

- Zero production code modifications. derive treats `claude` as a black box and continues to do so.
- The contract is the CLI interface, not an internal function signature. This is the real boundary.
- The substitute binary is reusable — any tool that spawns `claude -p` could use it for tests.

#### How derive calls `claude -p` (from `spec.ts` investigation)

derive spawns `claude` at `~/.local/bin/claude` with these args:

```
-p --verbose --output-format stream-json --include-partial-messages
--system-prompt "Output only Gherkin. No commentary, no markdown, no code fences."
--no-session-persistence --model sonnet --tools "" --effort low
```

Input is piped via stdin (`execa`'s `input:` option): the preamble + prompt concatenated as a single string.

The binary path is hardcoded: `const CLAUDE_BIN = path.join(os.homedir(), ".local", "bin", "claude")`.

#### How derive parses the output

derive parses NDJSON lines from stdout. It only cares about two event types:

1. **`stream_event` objects** — used for progress logging (dots to stderr). derive inspects:
   - `event.type === "content_block_start"` with `content_block.type` of `"thinking"`, `"tool_use"`, or `"text"` — used to log activity headers
   - `event.type === "content_block_delta"` — used to print progress dots (every 5th text chunk)
   - `event.type === "content_block_stop"` — resets block tracking state

   These are cosmetic — derive doesn't use delta content for the actual result.

2. **`result` object** — `{ type: "result", result: "..." }`. This is the final output. derive extracts `obj.result` as the complete text. This is the only thing that matters for correctness.

#### What the substitute binary must do

Minimum viable contract:

1. Accept `-p` flag and read stdin
2. Accept `--system-prompt <string>` (can ignore or use as system message for local model)
3. Accept and ignore: `--verbose`, `--output-format stream-json`, `--include-partial-messages`, `--no-session-persistence`, `--model`, `--tools`, `--effort`
4. Run stdin through a local model (node-llama-cpp + GGUF)
5. Output a single NDJSON line: `{"type":"result","result":"<model output>"}`
6. Optionally emit `stream_event` lines for progress — not required for correctness, just for fidelity

That's it. The substitute binary is a ~50-line Node script + node-llama-cpp dependency.

#### How tests use it

Option A (environment variable): derive reads `CLAUDE_BIN` from env (falling back to `~/.local/bin/claude`). Tests set `CLAUDE_BIN=/path/to/substitute`.
Option B (PATH manipulation): name the substitute `claude`, prepend its directory to PATH in the test env.

Option A is simpler and more explicit. It requires a one-line change in `spec.ts`:

```typescript
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? path.join(os.homedir(), ".local", "bin", "claude");
```

This is a trivial, safe change with no behavioral impact on production.

#### Model download and caching

The substitute binary handles model acquisition:

- On first run, downloads the GGUF model to `~/.cache/machinen/models/<model-name>.gguf`
- Subsequent runs use the cached file
- CI caches `~/.cache/machinen/models/`
- The download URL and model name are hardcoded in the substitute (or configurable via env var)

#### Summary

| Aspect                 | Detail                                                                |
| ---------------------- | --------------------------------------------------------------------- |
| Production code change | One line: `CLAUDE_BIN` from env var                                   |
| Substitute binary      | ~50-line Node script, `#!/usr/bin/env node`                           |
| Runtime                | `node-llama-cpp` as devDependency in derive                           |
| Model                  | SmolLM-135M-Instruct Q4_K_M (~105MB), fallback to Qwen3-0.6B (~296MB) |
| Model caching          | `~/.cache/machinen/models/`, one-time download                        |
| Cost                   | Zero. Local CPU inference.                                            |
| Runaway-safe           | Yes. No API calls, no money spent.                                    |
| Output contract        | Single NDJSON line: `{"type":"result","result":"..."}`                |

**Validation needed**: spike to confirm (a) node-llama-cpp can load and run a tiny GGUF, (b) the model produces Gherkin-like output, (c) the substitute binary's NDJSON output is parsed correctly by derive's existing code.

## Full picture: work breakdown

### Slice 1: first manual e2e test + substitute binary + test generation seed (this work unit)

This is the meaningful first slice. It delivers:

1. A working substitute binary (local AI drop-in for `claude -p`)
2. One manually written e2e test that exercises the full derive pipeline through the substitute
3. The test infrastructure (vitest config, test script, conventions)
4. A first implementation of test generation from specs — where derive reads the spec files and the existing manually-written test, and generates additional tests

#### Task 1: Substitute binary (`bin/fakeClaude`)

A `#!/usr/bin/env node` script that:

- Reads stdin (the preamble + prompt)
- Parses `--system-prompt` from argv
- Loads a tiny GGUF model via node-llama-cpp (auto-downloads on first run to `~/.cache/machinen/models/`)
- Runs inference
- Outputs `{"type":"result","result":"<output>"}\n` to stdout
- Exits

Dependencies: `node-llama-cpp` as devDependency in derive.

The binary path is injected via `CLAUDE_BIN` env var. One-line production change in `spec.ts`:

```typescript
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? path.join(os.homedir(), ".local", "bin", "claude");
```

#### Task 2: Test infrastructure

- Add `vitest` as devDependency
- Create `derive/vitest.config.ts` (following supervisor's pattern: sequential, no parallelism since tests share filesystem state)
- Add `"test": "vitest run"` to `derive/package.json`
- Establish test file location convention: `derive/src/*.test.ts` (co-located, matching monorepo pattern)

#### Task 3: First manual e2e test

**Scenario: one-shot spec update produces per-feature files from a synthetic conversation.**

This is the most representative e2e test because it exercises the full pipeline: conversation reading -> message extraction -> LLM call (via substitute) -> spec file writing. It touches every layer.

Test shape (pure e2e — spawn the CLI as a subprocess, no internal imports):

```
1. Set up temp dirs:
   - temp git repo: git init + git checkout -b test-branch
   - temp "projects" dir: create <slug>/<conversation-id>.jsonl with 3-4 synthetic user/assistant messages describing a simple feature
   - compute the slug from the temp repo path using the same replace(/[/_]/g, "-") logic
2. Spawn `tsx derive/src/index.ts` as a child process (via execa) with:
   - cwd: temp git repo
   - env.CLAUDE_BIN: path to the substitute binary
   - env.CLAUDE_PROJECTS_DIR: temp projects dir
   - env.MACHINEN_DB: temp db path (isolate from real DB)
3. Wait for process to exit successfully (exit code 0)
4. Assert on filesystem output:
   - <temp-repo>/.machinen/specs/ directory was created
   - At least one .feature file exists
   - Each .feature file starts with "Feature:"
   - File names are slugified feature names (lowercase, hyphens)
   - File content contains "Scenario:" and Given/When/Then steps
5. Teardown: rm temp dirs
```

This is fully black-box. No internal imports, no DB seeding, no function calls. The test interacts with derive the same way a user does — through the CLI and the filesystem.

Env var overrides needed in production code (all trivial one-line changes):

- `CLAUDE_BIN` in `spec.ts` — substitute binary path
- `CLAUDE_PROJECTS_DIR` in `index.ts` — temp projects dir
- `MACHINEN_DB` in `db.ts` — temp SQLite path (otherwise tests share the real global DB at `~/.machinen/machinen.db`)

```typescript
// spec.ts
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? path.join(os.homedir(), ".local", "bin", "claude");

// index.ts
const CLAUDE_PROJECTS_DIR =
  process.env.CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), ".claude", "projects");

// db.ts
const DB_PATH = process.env.MACHINEN_DB ?? path.join(os.homedir(), ".machinen", "machinen.db");
```

#### Task 4: Test generation — first implementation

This is where derive starts generating tests from specs. The mechanism:

1. derive reads the spec files (`.machinen/specs/**/*.feature`) — already has `readSpec` for this
2. derive reads the existing test files (e.g. `derive/src/*.test.ts`) — concatenates them as "convention examples"
3. derive calls `claude -p` (or the substitute in tests) with a test-generation system prompt + the spec content + the existing test code
4. The prompt instructs: "here are the specs, here are the existing tests, generate additional tests following the same conventions, do not read any source code"
5. derive writes the output to new test files

Key design: the test generation call uses `--tools ""` (no filesystem access) and receives everything via stdin. The stdin payload is: system prompt + spec content + existing test code. This enforces the source code isolation constraint — the LLM cannot read `spec.ts`, `index.ts`, etc.

For this slice, test generation is a separate command: `derive gen-tests --scope <name>`. It reads specs from `.machinen/specs/<scope>/`, reads existing tests from a configured test directory, and writes generated tests. This is manual-only for now — no watch mode, no automatic triggering.

The generated tests follow the same conventions as the manually-written test (vitest, temp dirs, substitute binary, structural assertions). The manually-written test is the "seed" that teaches the generator what good tests look like.

### Deferred (designed now, built later)

#### Mode integration

- `derive` one-shot automatically runs test gen after spec update (opt-out: `--no-tests`)
- `derive watch` watches specs for changes and triggers test gen (opt-out: `--no-tests`)
- `derive gen-tests --watch` watches spec files independently
- These all build on the `gen-tests` one-shot command from Slice 1

#### Human review step

- Implicit: specs land on disk, user reviews via `git diff` or IDE
- The pipeline doesn't need an explicit pause — the human reviews the spec files between `derive` and `derive gen-tests` (in manual mode), or reviews generated tests before committing (in auto mode)
- No structured review UI for now — just files on disk

#### Supervisor integration

- After tests are generated and written, the supervisor picks them up as part of its normal workflow
- The trigger mechanism: either derive signals the supervisor (e.g. writes a trigger file), or the supervisor watches test files
- This is the existing supervisor's responsibility — derive just writes files

#### Watch mode for test gen

- `derive watch` already re-runs spec update on JSONL changes
- Extending it to also re-run test gen on spec changes means watching a second directory (`.machinen/specs/`)
- Could be a second chokidar watcher in the same process, or a separate `derive gen-tests --watch` process

#### Test file location

- Generated tests go to `derive/src/generated.test.ts` (or split by feature: `derive/src/<feature-slug>.generated.test.ts`)
- `.generated.test.ts` suffix distinguishes from hand-written tests
- Generated tests are committed to the repo and travel with the branch (same as spec files)

### Slice 1 task summary

| #   | Task                    | Description                                                                                                            |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | Substitute binary       | `bin/fakeClaude` — local AI drop-in for `claude -p`                                                                    |
| 2   | Env var overrides       | Make `CLAUDE_BIN`, `CLAUDE_PROJECTS_DIR`, and `MACHINEN_DB` configurable via env in `spec.ts`, `index.ts`, and `db.ts` |
| 3   | Test infrastructure     | vitest config, test script, devDependencies                                                                            |
| 4   | First manual e2e test   | Full pipeline: synthetic JSONL -> substitute binary -> .feature file output                                            |
| 5   | Test generation command | `derive gen-tests` — reads specs + existing tests, generates new tests via `claude -p`                                 |

## RFC: Task 1 — Substitute binary (`bin/fakeClaude`)

### 2000ft View

We need a drop-in replacement for the `claude` CLI that runs a local LLM instead of calling Anthropic's API. This enables e2e testing of derive's full pipeline — from conversation reading through LLM-based spec generation to file output — without spending money, requiring credentials, or risking runaway API costs.

The substitute binary is a Node script at `bin/fakeClaude` that accepts the same CLI flags and stdin input that derive passes to `claude -p`, runs the input through a tiny local GGUF model via `node-llama-cpp`, and emits NDJSON output in the same format derive expects. derive doesn't know or care that it's talking to a local model — the binary path is swapped via the `CLAUDE_BIN` env var.

### Behavior Spec

```gherkin
Feature: Substitute Claude binary

  Scenario: fakeClaude produces NDJSON result from stdin input
    Given fakeClaude is invoked with "-p" and stdin containing a prompt
    When the process completes
    Then stdout contains a JSON line with type "result" and a non-empty result string
    And the process exits with code 0

  Scenario: fakeClaude accepts claude-compatible CLI flags
    Given fakeClaude is invoked with flags: -p --verbose --output-format stream-json --model sonnet --tools "" --effort low --no-session-persistence --system-prompt "some prompt"
    When the process completes
    Then the process does not error on unrecognized flags
    And stdout contains a JSON line with type "result"

  Scenario: fakeClaude uses system prompt for inference
    Given fakeClaude is invoked with --system-prompt "Output only Gherkin"
    And stdin contains text describing a feature
    When the process completes
    Then the result string contains Gherkin-like content

  Scenario: Model is downloaded on first run
    Given no model file exists in the cache directory
    When fakeClaude is invoked
    Then the model is downloaded to the cache directory
    And subsequent invocations use the cached model without downloading

  Scenario: fakeClaude reads input from stdin
    Given fakeClaude is invoked with "-p"
    And "Hello world" is piped to stdin
    When the process completes
    Then the result is based on the stdin content
```

### API Reference (CLI)

```
bin/fakeClaude -p [options]

Reads a prompt from stdin, runs it through a local GGUF model, outputs NDJSON to stdout.

Options (accepted for compatibility, behavior noted):
  -p                          Required. Enables prompt mode (reads stdin).
  --system-prompt <string>    Used as the system message for the local model.
  --model <name>              Accepted, ignored (always uses the local model).
  --tools <string>            Accepted, ignored.
  --effort <level>            Accepted, ignored.
  --verbose                   Accepted, ignored.
  --output-format <format>    Accepted, ignored (always outputs NDJSON).
  --include-partial-messages   Accepted, ignored.
  --no-session-persistence    Accepted, ignored.

Stdin:  The full prompt text (preamble + user prompt concatenated).
Stdout: One or more NDJSON lines. The final line is: {"type":"result","result":"<model output>"}
Exit:   0 on success, non-zero on failure.
```

### Implementation Breakdown

```
[NEW] bin/fakeClaude                — executable Node script (#!/usr/bin/env node)
[NEW] bin/fakeClaude.ts             — TypeScript source (compiled or run via tsx)
[MODIFY] package.json (root)        — add node-llama-cpp to devDependencies, add models:pull script
```

### Directory & File Structure

```
bin/
  fakeClaude                  — symlink or shebang script that runs fakeClaude.ts via tsx
  fakeClaude.ts               — TypeScript implementation
```

### Types & Data Structures

```typescript
// Output format — matches claude -p --output-format stream-json
interface ResultEvent {
  type: "result";
  result: string; // the model's text output
}
```

### System Flow

```
stdin (prompt text)
  |
  v
parse argv for --system-prompt
  |
  v
resolve model path (~/.cache/machinen/models/<name>.gguf)
  |
  +-- if not exists: download from HuggingFace URL → write to cache dir
  |
  v
getLlama() → loadModel(modelPath) → createContext() → LlamaChatSession
  |
  v
session.prompt(systemPrompt + stdinContent)
  |
  v
stdout: {"type":"result","result":"<output>"}\n
  |
  v
exit 0
```

### Invariants & Constraints

- The binary must accept all CLI flags that derive passes to `claude -p` without erroring, even if it ignores most of them.
- The NDJSON `result` event must be parseable by derive's existing `runClaude` output parser in `spec.ts` (lines 100-153).
- Model download must be idempotent — if the file exists at the cache path, skip the download.
- The binary must work when spawned via `execa` with `input:` (stdin piped, not TTY).
- The binary must not write to `~/.claude/projects/` or create session files (no ghost conversation risk).
- Model cache location: `~/.cache/machinen/models/`. Configurable via `MACHINEN_MODEL_CACHE` env var for CI.

### Model Selection

Start with **SmolLM-135M-Instruct Q4_K_M** (~105MB). If it cannot reliably produce text containing `Feature:` and `Scenario:` blocks, fall back to **Qwen3-0.6B Q2_K** (~296MB).

The model URL is hardcoded in the binary (e.g. `https://huggingface.co/QuantFactory/SmolLM-135M-Instruct-GGUF/resolve/main/SmolLM-135M-Instruct.Q4_K_M.gguf`). This can be overridden via `FAKECLAUDE_MODEL_URL` env var.

### Suggested Verification

1. Run `echo "Describe a login feature" | tsx bin/fakeClaude.ts -p --system-prompt "Output only Gherkin"` and inspect stdout for valid NDJSON with a `result` field
2. Run it again — second run should be faster (model already cached)
3. Parse the output with `JSON.parse()` and check `obj.type === "result"` and `obj.result` is non-empty
4. Inspect `~/.cache/machinen/models/` to confirm the GGUF file was downloaded

### Tasks

- [x] Add `node-llama-cpp` to root `devDependencies`
- [ ] ~~Add `models:pull` script to root `package.json`~~ — not needed, `resolveModelFile` auto-downloads on first use
- [x] Write `bin/fakeClaude.mts` — argv parsing, stdin reading, model loading, inference, NDJSON output
- [x] Make `bin/fakeClaude` executable (bash wrapper that calls `tsx bin/fakeClaude.mts`)
- [x] Spike: SmolLM-135M failed, switched to Qwen3-0.6B + `ensureGherkinStructure` post-processing

## Implementation: Task 1 — Substitute binary

Added `node-llama-cpp@^3.17.1` to root devDependencies and added it to `onlyBuiltDependencies` so pnpm runs its native build postinstall (compiles llama.cpp with Metal on macOS).

Implementation notes for `bin/fakeClaude.mts`:

- Uses `resolveModelFile("hf:QuantFactory/SmolLM-135M-Instruct-GGUF:Q4_K_M", modelsDir)` which auto-downloads the GGUF on first call and caches it. This eliminated the need for a separate `models:pull` script.
- Model cache defaults to `~/.cache/machinen/models/`, overridable via `MACHINEN_MODEL_CACHE`.
- Model URI overridable via `FAKECLAUDE_MODEL_URI` for switching to a larger model.
- Parses `--system-prompt` (used for LlamaChatSession constructor), `-p` (mode gate), and silently consumes all other flags derive passes.
- All diagnostic output goes to stderr; only the NDJSON result line goes to stdout.
- Cleanup: disposes context and model after inference.
- File uses `.mts` extension (not `.ts`) because `node-llama-cpp` uses top-level await internally, requiring ESM module output. tsx defaults to CJS for `.ts` but treats `.mts` as ESM.

`bin/fakeClaude` is a bash wrapper that resolves tsx from `node_modules/.bin/tsx` relative to repo root: `exec "$REPO_ROOT/node_modules/.bin/tsx" "$DIR/fakeClaude.mts" "$@"`

## Spike: Model quality validation

Tested three configurations:

**SmolLM-135M-Instruct Q4_K_M (~105MB)**: Failed. Produced Emacs Lisp gibberish instead of Gherkin, got stuck in a repetition loop (`(concat " "` repeated hundreds of times). Too small for any format following.

**Qwen3-0.6B Q4_K_M (~484MB) — plain prompt**: Partial. Produced coherent English bullet points about the topic, no repetition, but missed Gherkin format entirely. Can understand content but can't follow format instructions from system prompt alone.

**Qwen3-0.6B Q4_K_M — with few-shot example**: Produced `Feature:`, `Scenario:`, `Given/When/Then` steps when given an example in the prompt. However, with derive's actual preamble (no example), it produces `Given/When/Then` steps but omits the `Feature:` / `Scenario:` wrappers.

**Decision**: Default to Qwen3-0.6B and add `ensureGherkinStructure()` post-processing in fakeClaude. If the model output is missing `Feature:` blocks, wrap it in a minimal `Feature: Generated specification / Scenario: Generated scenario` structure. This keeps real AI doing content extraction while ensuring structural validity for derive's `writeSpec` parser.

Performance: ~1.3s inference with cached model (macOS, Apple Silicon). First run downloads ~484MB.

Updated default model URI from SmolLM-135M to Qwen3-0.6B in `bin/fakeClaude.mts`.

## Design pivot: deterministic template with keyword extraction

After implementing the local model approach, we identified a fundamental issue: local models (even Qwen3-0.6B at 484MB) produce non-deterministic output that requires post-processing hacks (`ensureGherkinStructure`) to be structurally valid. This introduces flakiness into tests — the very thing tests should eliminate.

The realization: the e2e test's job is to verify **derive's pipeline** (read JSONL -> call binary -> parse result -> write .feature files). The quality of AI output is irrelevant to that verification. What we need is a binary that:

1. Accepts the same CLI interface as `claude -p`
2. Returns deterministic, structurally valid Gherkin
3. Incorporates content from stdin so the output isn't completely static (keyword extraction)

This means we drop `node-llama-cpp` entirely. fakeClaude becomes a pure Node script with zero external dependencies — it parses stdin, extracts keywords/phrases, and templates them into a Gherkin structure. Deterministic, fast (~0ms inference), no model download, no flakiness.

## Revised RFC: Task 1 — Spec generation stub (`derive/test/scripts/fake-claude-gen-specs`)

### 2000ft View

We need a drop-in replacement for the `claude` CLI that produces deterministic Gherkin output for e2e testing. The binary reads stdin (derive's preamble + conversation excerpts), extracts keywords from the input, and templates them into structurally valid Gherkin. This enables testing of derive's full pipeline without calling Anthropic's API, downloading models, or introducing non-determinism.

The stub is a Node script at `derive/test/scripts/fake-claude-gen-specs` — living inside derive's test directory because it's a derive-specific test double, not a repo-wide utility. The name signals exactly what it is: a fake claude binary for generating specs. It accepts the same CLI flags and stdin input that derive passes to `claude -p` and emits NDJSON output in the same format derive expects. No AI, no model, no network — just keyword extraction and string templating.

### Behavior Spec

```gherkin
Feature: Fake Claude spec generation binary

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
```

### API Reference (CLI)

```
derive/test/scripts/fake-claude-gen-specs -p [options]

Reads a prompt from stdin, extracts keywords, outputs deterministic Gherkin as NDJSON to stdout.

Options (accepted for compatibility, all ignored):
  -p                          Required. Enables prompt mode (reads stdin).
  --system-prompt <string>    Accepted, ignored (output is always Gherkin).
  --model <name>              Accepted, ignored.
  --tools <string>            Accepted, ignored.
  --effort <level>            Accepted, ignored.
  --verbose                   Accepted, ignored.
  --output-format <format>    Accepted, ignored (always outputs NDJSON).
  --include-partial-messages   Accepted, ignored.
  --no-session-persistence    Accepted, ignored.

Stdin:  The full prompt text (preamble + user prompt concatenated).
Stdout: One NDJSON line: {"type":"result","result":"<gherkin output>"}
Exit:   0 on success, non-zero on failure.
```

### Implementation Breakdown

```
[NEW]    derive/test/scripts/fake-claude-gen-specs      — bash wrapper (executable)
[NEW]    derive/test/scripts/fake-claude-gen-specs.mts   — keyword extraction + Gherkin templating
[DELETE] bin/fakeClaude                              — superseded
[DELETE] bin/fakeClaude.mts                          — superseded
[REMOVE] node-llama-cpp from root devDependencies   — no longer needed
```

### Directory & File Structure

```
derive/
  test/
    scripts/
      fake-claude-gen-specs        — bash wrapper: exec tsx fake-claude-gen-specs.mts "$@"
      fake-claude-gen-specs.mts    — TypeScript implementation
```

### Keyword Extraction Strategy

Uses `keyword-extractor` npm package (zero dependencies, built-in English stopword list) to strip noise words from the input, combined with regex extraction for structured tokens:

1. Split stdin into lines, filter to `[human]:` / `[assistant]:` prefixed lines (derive's excerpt format)
2. Extract flag-like tokens via regex (`--reset`, `--scope`, etc.) — these are always meaningful
3. Run remaining text through `keyword_extractor.extract()` with `{ language: "english", return_chained_words: true }` to get meaningful word groups with stopwords removed
4. Deduplicate and take the top N keywords
5. Template into Gherkin: one `Feature:` block, one `Scenario:` per keyword/phrase, with `Given/When/Then` steps

For example, input containing `[human]: We need to add a --reset flag that regenerates the spec from scratch` produces:

```gherkin
Feature: Extracted specification

  Scenario: reset flag
    Given the system is initialized
    When the user invokes --reset
    Then the expected behavior for reset is observed

  Scenario: regenerates spec scratch
    Given the system is initialized
    When the user triggers regenerates spec scratch
    Then the expected behavior is observed
```

`keyword-extractor` adds as a devDependency in derive (not root — it's only used by the test stub).

### Types & Data Structures

```typescript
interface ResultEvent {
  type: "result";
  result: string;
}
```

### System Flow

```
stdin (prompt text)
  |
  v
parse argv for -p flag (gate)
  |
  v
extract keywords from stdin:
  - [human]/[assistant] line content
  - flag tokens (--flag)
  - action verbs + objects
  - quoted strings
  |
  v
template keywords into Gherkin:
  - one Feature block
  - one Scenario per keyword group
  - Given/When/Then steps per scenario
  |
  v
stdout: {"type":"result","result":"<gherkin>"}\n
  |
  v
exit 0
```

### Invariants & Constraints

- The binary must accept all CLI flags that derive passes without erroring.
- The NDJSON `result` event must be parseable by derive's existing `runClaude` output parser in `spec.ts`.
- Output must always contain at least one `Feature:` block so `writeSpec` produces at least one .feature file.
- Output must be deterministic: same input always produces same output.
- The binary must work when spawned via `execa` with `input:` (stdin piped, not TTY).
- Zero external dependencies beyond Node.js stdlib (no model downloads, no network).

### Suggested Verification

1. Run `echo "[human]: Add a --reset flag for spec regeneration" | derive/test/scripts/fake-claude-gen-specs -p` and inspect stdout
2. Run it twice — output must be identical
3. Parse the output with `JSON.parse()` and check `obj.type === "result"` and `obj.result` contains `Feature:`
4. Pass it the full set of flags derive uses — no errors

### Tasks

- [x] ~~Add `node-llama-cpp` to root `devDependencies`~~ — reverted, no longer needed
- [x] ~~Spike: SmolLM-135M / Qwen3-0.6B~~ — informed the pivot to deterministic approach
- [x] Remove `node-llama-cpp` from root `devDependencies` and `onlyBuiltDependencies`
- [x] Delete `bin/fakeClaude` and `bin/fakeClaude.mts`
- [x] Add `keyword-extractor` to derive devDependencies
- [x] Write `derive/test/scripts/fake-claude-gen-specs.mts` — keyword extraction + Gherkin templating
- [x] Write `derive/test/scripts/fake-claude-gen-specs` — bash wrapper
- [x] Verify deterministic output end-to-end

## Implementation: Revised Task 1 — Deterministic spec generation stub

Removed `node-llama-cpp` from root (54 packages removed). Deleted `bin/fakeClaude` and `bin/fakeClaude.mts`.

Added `keyword-extractor@^0.0.28` to derive devDependencies. Zero transitive deps — just a stopword list and a split/filter function.

Created `derive/test/scripts/fake-claude-gen-specs.mts`:

- Reads stdin, filters to `[human]:`/`[assistant]:` prefixed lines (derive's excerpt format)
- Falls back to all non-empty lines if no conversation-formatted lines found (handles the review pass which sends raw Gherkin)
- Extracts `--flag` tokens via regex — these become individual Scenario blocks
- Runs remaining text through `keyword_extractor.extract()` with `{ language: "english", return_chained_words: true, remove_duplicates: true }`
- Templates flags and keywords into a single Feature block with Given/When/Then scenarios
- Outputs `{"type":"result","result":"<gherkin>"}` NDJSON line to stdout
- All diagnostic output to stderr, only NDJSON to stdout

Created `derive/test/scripts/fake-claude-gen-specs` bash wrapper — resolves tsx from `node_modules/.bin/tsx` relative to repo root (3 levels up from scripts dir).

Verified:

- Produces valid Gherkin: Feature:, Scenario:, Given/When/Then all present
- Deterministic: two runs with identical input produce identical output
- Accepts all claude -p flags without error
- NDJSON parseable with JSON.parse(), type === "result"
- ~0ms execution time (no model, no network)

## Post-Task Review: Task 1 — Spec generation stub

Reviewed the diff against the Revised RFC (worklog lines 635-812):

- `[NEW] derive/test/scripts/fake-claude-gen-specs` — Created, executable. Match.
- `[NEW] derive/test/scripts/fake-claude-gen-specs.mts` — Created, 157 lines. Match.
- `[DELETE] bin/fakeClaude`, `bin/fakeClaude.mts` — Gone (never committed). Match.
- `[REMOVE] node-llama-cpp` from root — Removed (54 packages cleaned). Match.
- `keyword-extractor` in derive devDependencies — `"^0.0.28"`. Match.
- NDJSON output format — Verified. Match.
- Deterministic output — Verified. Match.
- Accepts all claude -p flags — Verified. Match.
- Feature: block always present (fallback scenario) — Match.
- Zero external deps beyond keyword-extractor — Match.

**Outcome**: Nothing unplanned introduced. Implementation matches RFC spec. All invariants hold. Task 1 complete.

## RFC: Tasks 2+3+4 — Env var overrides, test infrastructure, and first e2e test

Rolling Tasks 2, 3, and 4 into a single task unit because they form one cohesive deliverable: a working e2e test that proves the full derive pipeline runs end-to-end in isolation.

### 2000ft View

We need to make derive's three hardcoded paths configurable via environment variables, set up vitest in the derive package, and write the first e2e test that exercises the full pipeline: synthetic JSONL conversation file -> derive CLI (with `fake-claude-gen-specs` as CLAUDE_BIN) -> `.feature` file output on disk.

The test is fully black-box: it spawns derive as a subprocess (via `tsx derive/src/index.ts`), injects env vars for complete isolation (temp dir for DB, temp dir for conversation files, stub binary for Claude), and asserts on the filesystem output. No internal imports from derive's source.

### Behavior Spec

```gherkin
Feature: Derive e2e test infrastructure

  Scenario: Env var overrides for test isolation
    Given CLAUDE_BIN is set to the fake-claude-gen-specs stub
    And MACHINEN_DB is set to a temp directory path
    And CLAUDE_PROJECTS_DIR is set to a temp directory path
    When derive is spawned as a subprocess
    Then derive uses the stub binary instead of the real claude CLI
    And derive creates its database in the temp directory
    And derive reads conversations from the temp projects directory

  Scenario: One-shot spec update from a single conversation
    Given a temp directory structure with:
      | path                                        | content                    |
      | projects/{slug}/{conversation-id}.jsonl      | synthetic JSONL fixture    |
      | repo/                                        | empty working directory    |
    And CLAUDE_BIN points to fake-claude-gen-specs
    And MACHINEN_DB points to a temp file
    And CLAUDE_PROJECTS_DIR points to the temp projects directory
    When derive is run in one-shot mode with cwd=repo/
    Then derive discovers the conversation
    And derive invokes the stub binary (not the real claude)
    And .machinen/specs/*.feature files are created inside the repo directory
    And the .feature files contain valid Gherkin with Feature: and Scenario: blocks
    And the process exits with code 0
```

### Implementation Breakdown

#### Part A: Env var overrides (production code changes)

Three one-line changes to make hardcoded paths configurable:

```
[MODIFY] derive/src/spec.ts:8
  Before: const CLAUDE_BIN = path.join(os.homedir(), ".local", "bin", "claude");
  After:  const CLAUDE_BIN = process.env.CLAUDE_BIN ?? path.join(os.homedir(), ".local", "bin", "claude");

[MODIFY] derive/src/index.ts:16
  Before: const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
  After:  const CLAUDE_PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), ".claude", "projects");

[MODIFY] derive/src/db.ts:7
  Before: const DB_PATH = path.join(os.homedir(), ".machinen", "machinen.db");
  After:  const DB_PATH = process.env.MACHINEN_DB ?? path.join(os.homedir(), ".machinen", "machinen.db");
```

Zero behavioral change when env vars are unset — existing defaults preserved.

#### Part B: Test infrastructure

```
[NEW]    derive/test/e2e/derive-one-shot.test.ts   — first e2e test
[NEW]    derive/test/e2e/harness.ts                 — reusable test harness (setup/teardown)
[MODIFY] derive/package.json                        — add "test" script
```

No separate vitest config for derive — the root `vitest.config.ts` already applies to all packages (it only excludes `_/`, `node_modules/`, `dist/`). The root `test:unit` script runs `pnpm -r test`, so adding a `"test"` script to derive's package.json is enough to integrate with the monorepo test runner.

#### Part C: First e2e test

The test creates a fully isolated temp directory structure that mimics what derive expects:

```
$TMPDIR/derive-test-XXXXX/
  projects/                          # CLAUDE_PROJECTS_DIR
    -tmp-derive-test-xxxxx-repo/     # slugified cwd → slug dir
      abc123.jsonl                   # synthetic conversation
  repo/                              # the "repo" cwd (where .machinen/specs/ will appear)
  machinen.db                        # MACHINEN_DB (SQLite file, created by derive)
```

**Synthetic JSONL fixture**: Minimal valid conversation that `readFromOffset` + `discoverConversations` will accept. Needs:

- At least one line with `type: "user"` or `type: "assistant"`
- The `cwd` field matching our fake repo path
- The `gitBranch` field matching the branch we'll claim to be on
- A `message.content` field with text that the stub binary can extract keywords from

**Branch detection**: derive calls `git rev-parse --abbrev-ref HEAD` to get the current branch. Since our temp "repo" isn't a real git repo, we need to handle this. Two options:

1. `git init` the temp repo dir and create a branch
2. Override `getCurrentBranch()` somehow

Option 1 is cleaner for a black-box test — we `git init` the temp repo dir and create a named branch. This avoids any production code changes beyond the three env var overrides.

**Slug computation**: derive slugifies `cwd` by replacing `/` and `_` with `-`. Our test must set up the JSONL file at the path that derive's `getSlugDir(cwd)` would compute. For example if `cwd` is `/tmp/derive-test-xxx/repo`, the slug dir under CLAUDE_PROJECTS_DIR would be `projects/-tmp-derive-test-xxx-repo/`.

#### Part D: Test harness (`derive/test/e2e/harness.ts`)

A reusable utility that encapsulates the temp directory setup, git init, slug computation, JSONL fixture writing, derive invocation, and cleanup. Every e2e test reuses this instead of duplicating boilerplate.

```typescript
interface HarnessOptions {
  branch?: string; // default: "test-branch"
  conversations?: Array<{
    // synthetic JSONL conversations to write
    id?: string; // default: random UUID
    messages: Array<{
      type: "user" | "assistant";
      content: string;
    }>;
  }>;
  deriveArgs?: string[]; // extra args to pass to derive (e.g. "--reset", "--scope foo")
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

The harness tracks all created temp directories at module level and cleans up automatically. Tests never think about cleanup — just import `setupDeriveTest` and use it.

- `setupDeriveTest(opts: HarnessOptions)` — creates temp dirs, git inits repo, writes JSONL fixtures, returns paths + a `run()` function
- The returned `run()` spawns derive as subprocess with all env vars pointing to temp dirs

Cleanup is fully implicit: the module maintains a `Set<string>` of temp root paths. Each `setupDeriveTest` call adds its temp root. An `afterEach` hook registered at module level (side effect on import) iterates the set, removes each directory, and clears the set.

```typescript
// Inside harness.ts — module-level side effect
const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});
```

Usage pattern in tests — no cleanup code needed:

```typescript
import { setupDeriveTest } from "./harness.mjs";

it("one-shot spec update from a single conversation", async () => {
  const { run, specDir } = await setupDeriveTest({
    branch: "test-branch",
    conversations: [
      {
        messages: [
          { type: "user", content: "Add a --reset flag for spec regeneration" },
          { type: "assistant", content: "I will implement --reset to regenerate specs" },
        ],
      },
    ],
  });

  const result = await run();
  expect(result.exitCode).toBe(0);
  // ... assert on result.featureFiles, specDir contents, etc.
});
```

Internal responsibilities of the harness:

1. Module-level `afterEach` hook registered as side effect on import — cleans up all tracked temp dirs
2. `fs.mkdtempSync()` to create a unique temp root; add path to tracking set
3. Create `projects/` and `repo/` subdirs
4. `git init` + `git checkout -b <branch>` in the repo dir (+ an initial commit so HEAD exists)
5. Compute slug from repo path: `repoPath.replace(/[/_]/g, "-")`
6. Create slug dir under projects, write each conversation as `{id}.jsonl`
7. Each JSONL line includes `cwd`, `gitBranch`, `sessionId` matching the test params
8. `run()` spawns `tsx derive/src/index.ts` with `CLAUDE_BIN`, `CLAUDE_PROJECTS_DIR`, `MACHINEN_DB` env vars
9. After run, reads `.machinen/specs/` to populate `featureFiles` in the result

### Directory & File Structure

```
derive/
  test/
    scripts/
      fake-claude-gen-specs          # (already exists from Task 1)
      fake-claude-gen-specs.mts      # (already exists from Task 1)
    e2e/
      harness.ts                     # reusable test setup/teardown/run utility
      derive-one-shot.test.ts        # first e2e test
  src/
    spec.ts                          # CLAUDE_BIN env var override
    index.ts                         # CLAUDE_PROJECTS_DIR env var override
    db.ts                            # MACHINEN_DB env var override
  package.json                       # add "test" script
```

### Synthetic JSONL Fixture Format

Each line is a JSON object. Minimal valid conversation (two lines):

```jsonl
{"type":"user","sessionId":"test-session","cwd":"/tmp/derive-test-xxx/repo","gitBranch":"test-branch","message":{"role":"user","content":"We need to add a --reset flag that regenerates specs from scratch"}}
{"type":"assistant","sessionId":"test-session","cwd":"/tmp/derive-test-xxx/repo","gitBranch":"test-branch","message":{"role":"assistant","content":"I will implement a --reset flag that clears existing specs and reprocesses all conversations"}}
```

The fixture is generated inline in the test (not a separate fixture file) because the paths must match the temp directory created at test time.

### Types & Data Structures

No new types. The test uses `execa` to spawn the subprocess and `fs` to inspect output.

### System Flow

```
test setup:
  mkdtemp → create temp dirs (projects/, repo/)
  git init → temp repo (so getCurrentBranch works)
  write synthetic JSONL → projects/{slug}/{id}.jsonl

test execution:
  execa("tsx", ["derive/src/index.ts"], {
    cwd: tempRepo,
    env: {
      CLAUDE_BIN: path.resolve("derive/test/scripts/fake-claude-gen-specs"),
      CLAUDE_PROJECTS_DIR: tempProjects,
      MACHINEN_DB: tempDb,
    }
  })

assertions:
  - exit code 0
  - .machinen/specs/*.feature files exist in tempRepo
  - .feature content contains Feature: and Scenario:
  - .feature content contains keywords from the synthetic conversation
```

### Invariants & Constraints

- The test must not touch the real `~/.machinen/` or `~/.claude/` directories.
- The test must not call the real `claude` CLI.
- The test must not depend on network access.
- Temp directories must be cleaned up after the test.
- The env var overrides must have zero behavioral change when unset (existing defaults preserved).
- The test must be runnable via `pnpm -r test` from the repo root.

### Suggested Verification

1. Run `pnpm --filter derive test` — the e2e test should pass.
2. Inspect the test output to confirm derive discovers the synthetic conversation, invokes the stub, and writes .feature files.
3. Verify that `~/.machinen/machinen.db` was not modified during the test run (isolation check).

### Tasks

- [ ] Add env var override to `derive/src/spec.ts` (CLAUDE_BIN)
- [ ] Add env var override to `derive/src/index.ts` (CLAUDE_PROJECTS_DIR)
- [ ] Add env var override to `derive/src/db.ts` (MACHINEN_DB)
- [ ] Add `"test"` script to `derive/package.json`
- [ ] Write `derive/test/e2e/harness.ts` — reusable test setup/teardown/run utility
- [ ] Write `derive/test/e2e/derive-one-shot.test.ts`
- [ ] Run the test, verify it passes

## Blueprint split: derive test infrastructure

Split the test infrastructure documentation out of `.docs/blueprints/derive.md` into its own blueprint at `.docs/blueprints/derive-test-infra.md`. The derive blueprint's "Test isolation" section was trimmed to a three-line summary pointing to the new blueprint. The directory mapping was also simplified — `test/` now points to the test infra blueprint rather than listing individual files.

The test infra blueprint covers:

- Substitute binary (`fake-claude-gen-specs`) — CLI contract, keyword extraction strategy, NDJSON output format, determinism guarantees
- Test harness (`harness.ts`) — `setupDeriveTest()` API, types, temp directory layout, slug computation, JSONL fixture format, git init, cleanup
- Env var override contract — the three env vars, defaults, invisibility when unset
- Synthetic JSONL fixture format — minimal valid structure, required fields
- E2e test conventions — black-box, vitest, structural assertions

The derive blueprint retains a brief "Test isolation" section that names the three env vars and links to the test infra blueprint for details.

## Implementation: Tasks 2+3+4 — Env var overrides, test infrastructure, and first e2e test

### Part A: Env var overrides

Three one-line changes, exactly as specified in the RFC:

- `derive/src/spec.ts:8` — `CLAUDE_BIN` reads from `process.env.CLAUDE_BIN` with fallback to `~/.local/bin/claude`
- `derive/src/index.ts:16-17` — `CLAUDE_PROJECTS_DIR` reads from `process.env.CLAUDE_PROJECTS_DIR` with fallback to `~/.claude/projects`
- `derive/src/db.ts:7` — `DB_PATH` reads from `process.env.MACHINEN_DB` with fallback to `~/.machinen/machinen.db`

Zero behavioral change when env vars are unset.

### Part B: Test infrastructure

Added `"test": "vitest run"` to `derive/package.json`. No separate vitest config — the root `vitest.config.ts` applies.

Created `derive/test/e2e/harness.ts`:

- `setupDeriveTest(opts)` creates a fully isolated temp directory structure: `repo/` (git-initialized), `projects/<slug>/` (with JSONL fixtures), and a `machinen.db` path
- Returns `{ repoDir, projectsDir, dbPath, specDir, run }` where `run()` spawns derive as a subprocess with all env vars pointing to temp dirs
- Module-level `afterEach` hook (side effect on import) tracks all temp roots in a `Set<string>` and removes them after each test
- Slug computation mirrors derive's `getSlugDir`: `repoPath.replace(/[/_]/g, "-")`
- Git init + branch creation + empty initial commit so `getCurrentBranch()` works

### Part C: First e2e test

Created `derive/test/e2e/derive-one-shot.test.ts` with two tests:

1. **"produces .feature files from a synthetic conversation"** — single conversation with `--reset` flag discussion, asserts exit code 0, at least one .feature file, each file starts with `Feature:`, contains `Scenario:` and `Given/When/Then` steps
2. **"discovers multiple conversations for the same branch"** — two conversations (pagination + sorting topics), asserts both are processed into feature files with valid Gherkin structure

Both tests use 30s timeouts (subprocess spawning + two `claude -p` calls via the stub per spec update).

### Bug encountered: macOS symlink slug mismatch

On macOS, `os.tmpdir()` returns `/var/folders/...` but `process.cwd()` inside a subprocess resolves the symlink to `/private/var/folders/...`. This caused derive's `getSlugDir(process.cwd())` to compute a slug starting with `-private-var-...` while the test wrote the JSONL under the `-var-...` slug. Result: "slug dir does not exist — no conversations to discover."

Fix: `fs.realpathSync()` the temp root immediately after `mkdtempSync()`. All paths derived from it then match what the subprocess sees.

### Verification

Both tests pass:

```
pnpm --filter derive test

 ✓ test/e2e/derive-one-shot.test.ts (2 tests) 958ms
   ✓ produces .feature files from a synthetic conversation 492ms
   ✓ discovers multiple conversations for the same branch 466ms

 Test Files  1 passed (1)
      Tests  2 passed (2)
```

### Tasks

- [x] Add env var override to `derive/src/spec.ts` (CLAUDE_BIN)
- [x] Add env var override to `derive/src/index.ts` (CLAUDE_PROJECTS_DIR)
- [x] Add env var override to `derive/src/db.ts` (MACHINEN_DB)
- [x] Add `"test"` script to `derive/package.json`
- [x] Write `derive/test/e2e/harness.ts` — reusable test setup/teardown/run utility
- [x] Write `derive/test/e2e/derive-one-shot.test.ts`
- [x] Run the test, verify it passes

## RFC: Task 5 — Test generation command (`derive tests`)

### 2000ft View

We need a `derive gen-tests` command that spawns an **agentic** `claude -p` session to generate tests from Gherkin specs. Unlike the spec pipeline (which uses `--tools ""` for a single non-interactive LLM call), gen-tests gives Claude full filesystem tool access so it can read specs, discover existing test conventions, and write test files directly.

The key constraint is **source code isolation**: Claude must not read implementation source files — only spec files, test files, test utilities, fixtures, and config files. This is enforced via convention-based system prompt instruction ("read only test files and specs, not implementation source code") rather than path-specific exclusions, because gen-tests is designed to work in arbitrary projects where directory layouts vary. The constraint is soft but reliable given Claude's instruction-following, and backstopped by human review of generated tests before committing.

Hard isolation mechanisms were evaluated and rejected:

- `.claudeignore` is repo-global — it would affect all Claude interactions, not just gen-tests
- `--disallowed-tools` blocks tools by name, not by path — can't say "allow Read but only for `test/`"
- Temp dir copy is fragile and slow — and defeats the purpose of letting Claude discover project structure organically

The command reads specs from `.machinen/specs/[<scope>]/`, lets Claude explore the project's test directory and config files to understand conventions, and Claude writes test files directly to wherever the project's existing tests live. No `.generated` suffix — the tests are first-class citizens, reviewed and committed like any other code.

### Behavior Spec

```gherkin
Feature: Test generation from specs

  Scenario: gen-tests generates test files from spec files
    Given .machinen/specs/derive/ contains Gherkin .feature files
    And existing test files exist in the project
    When derive gen-tests --scope derive is run
    Then Claude reads the spec files and existing test conventions
    And Claude writes new test files alongside existing tests
    And the process exits with code 0

  Scenario: gen-tests respects source code isolation
    Given derive gen-tests is run
    When Claude generates tests
    Then Claude does not read implementation source files
    And the generated tests are black-box — no internal imports from source modules

  Scenario: gen-tests uses scope flag to target spec subset
    Given .machinen/specs/derive/ contains feature files
    And .machinen/specs/other/ contains different feature files
    When derive gen-tests --scope derive is run
    Then only specs from .machinen/specs/derive/ are referenced

  Scenario: gen-tests skips conversation discovery
    Given derive gen-tests is run
    Then derive does not call discoverConversations
    And derive does not require CLAUDE_PROJECTS_DIR
```

### API Reference (CLI)

```
derive gen-tests [options]

Spawns an agentic Claude session to generate tests from Gherkin specs.

Options:
  --scope <name>    Target specs in .machinen/specs/<name>/ (default: .machinen/specs/)
  --verbose         Pass --verbose to the Claude subprocess for raw NDJSON logging

Claude receives filesystem tools (Read, Write, Edit, Glob, Grep) and writes test files directly.
The process exits when Claude's agentic loop completes.
```

### Implementation Breakdown

```
[NEW]    derive/src/gen-tests.ts              — gen-tests entry point: system prompt, claude invocation
[MODIFY] derive/src/index.ts                  — add gen-tests dispatch before discoverConversations
[MODIFY] derive/src/spec.ts                   — export CLAUDE_BIN (or extract shared binary resolution)
```

### System Flow

```
derive gen-tests --scope derive
  |
  v
main() — parse --scope, detect "gen-tests" subcommand
  |
  v
skip discoverConversations (gen-tests doesn't need conversations or DB)
  |
  v
runGenTests(cwd, scope?)
  |
  v
resolve spec dir: <cwd>/.machinen/specs/[<scope>]/
  |
  v
construct system prompt:
  - role: test generation agent
  - spec location: <specDir>
  - isolation: read only test files, specs, and config — not implementation source
  - convention discovery: read existing test files
  - output: write test files alongside existing tests
  |
  v
construct user prompt:
  - "Generate tests for the specs at <specDir>."
  |
  v
spawn claude -p (agentic — no --tools ""):
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
claude reads specs, reads existing tests, writes new test files
  |
  v
process exits
```

### How it fits into `main()`

Currently `main()` calls `discoverConversations` unconditionally before mode dispatch. gen-tests doesn't need conversations, the DB, or even `getCurrentBranch()` (it reads specs from disk). The dispatch needs to happen early:

```typescript
async function main(): Promise<void> {
  const cwd = process.cwd();
  const args = process.argv.slice(2);

  const scopeIdx = args.indexOf("--scope");
  const scope = scopeIdx !== -1 ? args[scopeIdx + 1] : undefined;

  // gen-tests doesn't need branch detection, conversation discovery, or the DB
  if (args[0] === "gen-tests") {
    await runGenTests(cwd, scope);
    return;
  }

  const branch = getCurrentBranch();
  // ... rest of existing flow
}
```

This avoids the `getCurrentBranch()` call (which errors on detached HEAD) and the `discoverConversations` call (which requires `CLAUDE_PROJECTS_DIR` and does DB work). gen-tests is a clean, independent code path.

### The `runGenTests` function

Lives in a new file `derive/src/gen-tests.ts`:

```typescript
import { execa } from "execa";
import { specDir } from "./spec.js";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? path.join(os.homedir(), ".local", "bin", "claude");

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

  // Stream progress to stderr (reuse same NDJSON parsing as runClaude)
  // ...

  await proc;
}
```

Key differences from the existing `runClaude`:

| Aspect | `runClaude` (spec pipeline)                            | `runGenTests`                                          |
| ------ | ------------------------------------------------------ | ------------------------------------------------------ |
| Tools  | `--tools ""` (disabled)                                | Default (all tools enabled)                            |
| Effort | `--effort low`                                         | Default (not specified — full effort)                  |
| Input  | Preamble + conversation excerpts piped via stdin       | Short user prompt via stdin; Claude reads files itself |
| Output | Result text extracted from NDJSON, used by `writeSpec` | Side effects only — Claude writes files directly       |
| cwd    | Irrelevant (no filesystem tools)                       | Repo root (so Claude can navigate the project)         |

### System Prompt Design

The system prompt has two jobs:

1. **Direct Claude toward the right files**: specs at `<specDir>`, existing tests (Claude discovers where), config files
2. **Fence Claude away from source code**: convention-based instruction — "read only test files, specs, and config; do not read implementation source code"

The instruction is deliberately generic (not tied to specific directory names like `src/` or `lib/`) so it works across arbitrary project structures. Claude infers what counts as "implementation source" vs "test code" from file names, directory conventions, and import patterns — the same way a human developer would.

The user prompt provides the specific spec location. The system prompt provides the role, constraints, and approach. Claude's agentic loop handles the rest — reading specs, reading existing tests for convention examples, generating new tests, writing them.

### Source Code Isolation: Defense in Depth

The isolation is a soft constraint (convention-based system prompt instruction). Defense layers:

1. **System prompt**: "Do NOT read implementation source code" — convention-based, works across project structures
2. **Human review**: generated tests are reviewed before committing — reviewer catches any internal import violations
3. **Black-box test assertion**: the spec itself says tests should use external interfaces (CLI, filesystem), reinforcing the pattern Claude sees in the existing manual test

This is sufficient for our use case. The spec pipeline's hard constraint (`--tools ""`) was needed because the spec pipeline runs frequently and automatically. gen-tests runs on-demand, with human review of output.

### Testing Strategy

The gen-tests command is tested with manually-written tests that verify the pipeline mechanics — command dispatch, argument parsing, Claude invocation, and NDJSON streaming — without requiring a fake binary that simulates agentic behavior.

The tests cover:

1. **Command dispatch**: `args[0] === "gen-tests"` routes to `runGenTests`, skipping `getCurrentBranch()` and `discoverConversations`
2. **Spec dir resolution**: `--scope derive` resolves to `.machinen/specs/derive/`, no scope resolves to `.machinen/specs/`
3. **Claude invocation contract**: the spawned process receives the right flags (no `--tools ""`, no `--effort low`), system prompt, and env vars (`CLAUDECODE` stripped, `extendEnv: false`)
4. **NDJSON progress streaming**: tool use events are logged to stderr

These are unit/integration tests of `runGenTests` internals, not full e2e tests. Full e2e testing of gen-tests (with a substitute binary that reads specs and writes test files) is deferred — the gen-tests output is always human-reviewed, so the critical path is the command plumbing, not an automated end-to-end loop.

### NDJSON Progress Streaming

gen-tests reuses the same NDJSON parsing as `runClaude` for progress output. The stream events include tool use events (Read, Write calls), which are useful for observing what Claude is doing:

```
[claude] tool_use: Read({"file_path":".machinen/specs/derive/reset-mode.feature"})
[claude] tool_use: Read({"file_path":"derive/test/e2e/derive-one-shot.test.ts"})
[claude] generating text...
[claude] tool_use: Write({"file_path":"derive/test/e2e/reset-mode.test.ts","content":"..."})
```

The existing `runClaude` already handles `content_block_start` with `tool_use` type and logs tool names + input previews. This logging works as-is for the agentic case.

### Invariants & Constraints

- gen-tests must not require `getCurrentBranch()` — it works on spec files, not git state
- gen-tests must not call `discoverConversations` — no conversation/DB dependency
- gen-tests must use `--no-session-persistence` and strip `CLAUDECODE` — same recursion prevention as the spec pipeline
- gen-tests must not use `--tools ""` — tools must be enabled for filesystem access
- The `CLAUDE_BIN` env var must work for gen-tests (same override mechanism as spec pipeline)
- The system prompt must use convention-based isolation (not path-specific) so it works across arbitrary projects

### Suggested Verification

1. Run `derive gen-tests --scope derive` and observe Claude reading specs and writing test files
2. Inspect the generated test files — they should follow existing test conventions
3. Check that no internal source imports appear in generated tests
4. Run `pnpm --filter derive test` to verify generated tests pass alongside the existing manual test

### Tasks

- [ ] Create `derive/src/gen-tests.ts` — system prompt, `runGenTests` function, NDJSON progress streaming
- [ ] Modify `derive/src/index.ts` — add `gen-tests` dispatch before `getCurrentBranch()` and `discoverConversations`
- [ ] Extract shared NDJSON streaming logic from `runClaude` into a reusable helper (or duplicate with simplification)
- [ ] Write manually-authored tests for gen-tests (command dispatch, spec dir resolution, Claude invocation contract)
- [ ] Manual verification: run `derive gen-tests --scope derive`, inspect output

## Blueprint revision: split derive.md

Renamed `.docs/blueprints/derive.md` to `.docs/blueprints/derive-spec.md` (title updated to "derive — spec pipeline") and created `.docs/blueprints/derive-gen-tests.md` as a separate blueprint for the test generation command. The split reflects the architectural distinction: the spec pipeline and gen-tests share a CLI entry point and a couple of helpers (`CLAUDE_BIN`, `specDir()`, NDJSON streaming), but have fundamentally different flows — stateless text-in/text-out vs agentic with filesystem tools.

Cross-references added between all three blueprints (derive-spec, derive-gen-tests, derive-test-infra).

## Naming: `derive tests` (not `derive gen-tests`)

Standardized the subcommand name to `derive tests` throughout. The RFC used `gen-tests` in some places and `tests` in others. The CLI subcommand is `tests`, the internal file/function names remain `gen-tests.ts` / `runGenTests` (they describe _what the code does_ — generates tests — rather than the user-facing command name).

## Implementation: Task 5 — `derive tests` command

### NDJSON streaming extraction

Extracted the NDJSON parsing logic from `runClaude` in `spec.ts` into a shared `streamNdjsonProgress` function. The function accepts a `NodeJS.ReadableStream` (stdout from the Claude process) and optional callbacks (`onResult`). It handles all progress logging to stderr (thinking blocks, tool use with input preview, text generation dots) and dispatches the `result` event via callback.

`runClaude` now calls `streamNdjsonProgress(proc.stdout!, { onResult: (r) => { result = r; } })` — same behavior, shared code. `runGenTests` calls it without an `onResult` callback since gen-tests has no result to extract (its value is in files Claude writes).

Exported `CLAUDE_BIN` from `spec.ts` so `gen-tests.ts` can import it. `VERBOSE` stays internal — it's read by `streamNdjsonProgress` which lives in the same file.

### gen-tests.ts

Created `derive/src/gen-tests.ts` with:

- `GEN_TESTS_SYSTEM_PROMPT` — convention-based isolation instruction, directs Claude to read specs + existing tests + config, write tests, avoid implementation source
- `runGenTests(cwd, scope?)` — resolves spec dir, spawns `claude -p` with tools enabled (no `--tools ""`), default effort (no `--effort low`), NDJSON progress streaming, `CLAUDECODE` stripped, `extendEnv: false`, `--no-session-persistence`
- cwd set to the repo root so Claude can navigate the project structure

### index.ts dispatch

Added `derive tests` dispatch in `main()` before `getCurrentBranch()` and `discoverConversations()`. The `tests` subcommand is checked as `args[0] === "tests"` and returns early after `runGenTests` completes. This avoids the branch detection call (which errors on detached HEAD) and the DB-first discovery (which requires `CLAUDE_PROJECTS_DIR`).

### Verification

- Typecheck: clean
- Existing e2e tests: 2 passed (NDJSON refactor didn't break `runClaude`)

### Tasks

- [x] Extract shared NDJSON streaming logic from `runClaude` into `streamNdjsonProgress`
- [x] Export `CLAUDE_BIN` from `spec.ts`
- [x] Create `derive/src/gen-tests.ts` — system prompt, `runGenTests` function
- [x] Modify `derive/src/index.ts` — add `tests` dispatch before `getCurrentBranch()`
- [x] Typecheck passes
- [x] Existing e2e tests pass
- [ ] Manual verification: run `derive tests --scope derive`, inspect output
