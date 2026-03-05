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
