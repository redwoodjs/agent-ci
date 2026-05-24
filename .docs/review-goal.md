# Review goal — PR #367 opt-in Rust native execution

Target: merge `pp-rust-native-execution` for **`AGENT_CI_FORCE_RUST=1`** (opt-in). Default switch (RXP-090) is a separate gate.

Last reviewed: **`83eed175`** (`Address Rust parity review gaps`). CI `test` green; 151 Rust workspace tests passing.

## Verdict

**APPROVE** for opt-in merge.

Prior BLOCK and REQUEST CHANGES items are resolved. Remaining debt is documented follow-up work, not a merge blocker for the opt-in path.

## Rubric scorecard (must hold at merge)

| Criterion | Status |
|---|---|
| No file >1k LOC | Pass — max 651 (`crates/agent-ci-core/src/plan.rs`) |
| God modules decomposed | Pass — `agent-ci-core` / `agent-ci-runtime` / `agent-ci` bin |
| CI gates enforced | Pass — fmt, clippy, test, fixtures, golden, smoke |
| Shared TS↔Rust contracts | Pass — `fixture-plan.ts` + `fixtures-check.mjs` + Rust fixture tests |
| Wave concurrency | Pass — `run_concurrent_workers`, `--jobs`, unit tests |
| Memory-aware default jobs | Pass — shared `fixtures/job-limits/` vectors, TS + Rust |
| npm binary staging | Pass — `native:stage-packages` in `native-binaries.yml` |
| Architecture boundaries | Pass — `runtime → core`, `reusable` in core, thin bin `lib.rs` |

## Architecture (target state — achieved)

```
agent-ci (bin)     → run_command adapters, cli, clean, state
agent-ci-runtime   → docker, dtu, runner, macos_vm, wave
agent-ci-core      → workflow, expr, plan, reusable, matrix, events
```

Fixture layer: `crates/agent-ci/fixtures/` (10+ plan contracts, events, run-results, docker-socket, job-limits).

Canonical docs:

- [RFC: Rust crate split + fixture contract layer](rfcs/rust-crate-split-and-fixtures.md) — **Implemented**
- [Rust execution parity plan](rust-execution-parity-plan.md)

## Known debt (non-blocking for opt-in)

### `--all` orchestration ≠ TypeScript (medium)

Rust parallelizes **workflows** with an outer worker pool; each sub-plan uses `max_jobs: 1`, so a single workflow cannot consume multiple slots under `--all`.

TypeScript uses one **job-level** `globalLimiter` across all workflows and waves.

Also missing in Rust `--all` vs TS:

- Single shared DTU (each parallel branch starts its own)
- Session bootstrap (orphan cleanup, image prefetch)
- Warm-cache serialization

Smoke: two single-job workflows in `scripts/rust-smoke-parity.mjs` — adequate for opt-in, not full parity.

### `fixtures-check.mjs` docker-socket duplicate (low)

~90 LOC inline copy vs `packages/cli/src/docker/docker-socket.ts`. Fixtures catch drift; dedupe when touching that area.

### Long-term typing debt (low)

- `Result<String>` at crate boundaries
- DTU `BTreeMap<String, Value>` mutex farm in `agent-ci-runtime/src/dtu/state.rs`
- Bin crate duplicate serde deps (thin as adapters shrink)

### Local dev footgun (low)

`pnpm fixtures:check` imports `.ts` directly — requires **Node ≥24** (root `package.json`). Fails on Node 22 with `ERR_UNKNOWN_FILE_EXTENSION`. CI uses Node 24.

## Post-merge checklist (before RXP-090 default switch)

1. **Unify `--all` concurrency** — shared job-level semaphore across workflows (mirror TS `createConcurrencyLimiter`), not workflow-at-a-time with `max_jobs: 1` sub-plans.
2. **Session bootstrap for Rust `--all`** — one DTU, one cleanup/prefetch pass (TS `run.ts` session setup).
3. **Deduplicate docker-socket in `fixtures-check.mjs`** — import from `docker-socket.ts` with probe injection.
4. **Typed error enum** — when touching error paths (`AgentCiError` / `thiserror`).
5. **Audit bin crate deps** — whether `serde` / `serde_yaml` / `sha*` can stay runtime-only.

## Review arc (historical)

| Review | Verdict | Main issue |
|---|---|---|
| 1 | BLOCK | 3451-line `run_command.rs`, 3296-line `dtu.rs` god modules |
| 2 | REQUEST CHANGES | No CI gates, no wave concurrency, shadow fixtures |
| 3 | REQUEST CHANGES | Incomplete crate split, npm staging, `--all` drift |
| 4 | APPROVE @ `83eed175` | Parity gaps addressed |
| 5 | APPROVE @ `83eed175` | Unchanged — holds |

## What was fixed across the arc

- Decomposed god modules into `run_command/`, `dtu/`, `runner/`, `docker/`, `macos_vm/`, `expr/`
- Wave concurrency via `agent-ci-runtime/src/wave.rs` + `Arc<SharedExecutionContext>`
- macOS VM semaphore (`AGENT_CI_MACOS_VM_CONCURRENCY`)
- CI: `tests.yml` — rust fmt/check/clippy/test, `golden:cli`, `rust:smoke:parity`, fixture contracts
- Crate split: `agent-ci-core`, `agent-ci-runtime`, thin bin
- `reusable.rs` moved to core; `runtime → core` dependency
- `fixtures-check.mjs` uses canonical `planFixtureWorkflow` + `getDefaultMaxConcurrentJobsFromInputs`
- Memory-aware `default_max_concurrent_jobs` + shared fixture vectors
- `--all` parallel smoke + `execute_all_workflows_parallel`
- npm staging via `pnpm native:stage-packages`
- `host_runner_dir` → per-run `run_dir.join("runner")`

## Approval bar for default switch (RXP-090)

Do **not** flip default until:

- Post-merge checklist items 1–2 are done (minimum)
- Full in-repo smoke passes with Rust as default (no `AGENT_CI_FORCE_RUST=1`)
- TS fallback path documented and rollback tested
