# RFC: Rust crate split + fixture contract layer

## Status

Proposed — companion to [rust-native-binary-rewrite.md](./rust-native-binary-rewrite.md) and [rust-execution-parity-plan.md](../rust-execution-parity-plan.md).

## Problem

The native Rust implementation (~16k LOC) mirrors the TypeScript CLI without a shared contract layer. Parity is enforced by smoke workflows and a thin golden CLI check, but logic drift is still likely (`--all` orchestration, default job limits, plan shapes, NDJSON events).

The single `agent-ci` crate also mixes pure planning (workflow parse, schedule, expr) with IO-heavy runtime code (docker, dtu, macos_vm), slowing compile/test loops and making boundaries easy to violate.

## Goals

1. Split the workspace into **pure core** vs **runtime** vs **thin CLI bin**.
2. Introduce **fixture-driven contracts** both Rust and TypeScript must pass before Phase 9 (default switch).
3. Keep the public `agent-ci` command unchanged.

## Non-goals

- Rewriting the DTU in a third language or deleting TS before RXP-090.
- Async/tokio migration (blocking subprocess model stays until a measured need).
- Publishing fixture schemas to npm in v1 of this RFC.

## Proposed crate layout

```
crates/
  agent-ci-core/          # pure domain — no std::process, no TcpListener
    workflow/
    expr/
    matrix/
    plan/                 # RunPlan, schedule, decide, route (no execute)
    events/               # NDJSON event types + serialization
    state/                # run-result.json types

  agent-ci-runtime/       # IO + traits
    docker/
    dtu/
    runner/
    macos_vm/
    workspace/
    wave/                 # ConcurrentJobPool, SharedExecutionContext

  agent-ci/               # binary + lib re-exports for tests
    main.rs               # exit codes, stdio only
    cli/                  # clap (future), env bootstrap

  agent-ci-fixtures/      # optional test-only crate: load + assert fixtures
```

Dependency direction: `agent-ci` → `agent-ci-runtime` → `agent-ci-core`. Nothing in `core` depends on `runtime`.

### Migration phases

| Phase | Work                                                    | Gate                          | Status |
| ----- | ------------------------------------------------------- | ----------------------------- | ------ |
| RCS-1 | Extract `agent-ci-core` with workflow/expr/plan modules | `cargo test -p agent-ci-core` | Done   |
| RCS-2 | Move docker/dtu/runner/macos_vm to `agent-ci-runtime`   | existing `cargo test` green   | Done   |
| RCS-3 | Thin bin crate; `lib.rs` loses USAGE string             | `golden:cli`                  | Open   |
| RCS-4 | Fixture contract CI (below)                             | TS + Rust both pass           | Done   |

Each phase is a mergeable PR. No big-bang split.

## Fixture contract layer

### Directory layout

```
crates/agent-ci/fixtures/
  README.md
  workflows/              # input YAML
  plans/                  # expected RunPlan JSON (stable subset)
  events/                 # expected NDJSON lines per scenario
  run-results/            # expected run-result.json
  docker-socket/          # env + expected resolution (from existing TS tests)
```

### Contract rules

1. **Plans** — JSON snapshots of `RunPlan` with stable fields only (job ids, schedule waves, runner names, routes). Omit timestamps and absolute paths.
2. **Events** — Normalized NDJSON: strip `ts`, `runId`, volatile paths before compare.
3. **Run results** — Schema version + job names + status; omit duration jitter in unit fixtures.
4. **TS runner** — Add `pnpm fixtures:check` that runs the same loader against TS plan/output functions (Phase RCS-4).

### CI integration

Add to `.github/workflows/tests.yml` after Rust unit tests:

```yaml
- name: Check Rust fixture contracts
  run: cargo test -p agent-ci fixtures::
```

Future: optional job `fixtures:check:ts` comparing TS output to the same files.

### Adding a fixture

1. Add `workflows/my-case.yml`.
2. Run `cargo test plan_fixture_my_case -- --nocapture` once to bless snapshot (or hand-write minimal JSON).
3. PR must include both input and expected output.

## Error model (parallel track)

Replace `Result<T, String>` at crate boundaries with:

```rust
#[derive(Debug, thiserror::Error)]
pub enum Error { ... }
```

Convert to user strings in `agent-ci` bin only. Prioritize `plan`, `docker`, `wave` modules first.

## DTU typing (parallel track)

Replace `BTreeMap<String, Value>` job storage with:

```rust
struct RunnerSession { ... }
struct DtuStateInner {
    runners: BTreeMap<RunnerName, RunnerSession>,
    cache: CacheStore,
    artifacts: ArtifactStore,
}
```

Single `Mutex<DtuStateInner>`. Serialize to JSON at HTTP handlers only.

## CLI (parallel track)

Replace hand-written `USAGE` in `lib.rs` with `clap` derive. Generate help golden from `CommandFactory::command().render_help()` or shared JSON spec consumed by TS.

## Wave executor

`run_command/wave.rs` owns concurrent job dispatch:

- `SharedExecutionContext` behind `Arc` (no per-worker clone).
- `run_concurrent_pool` — testable concurrency primitive with unit tests for `max_jobs`.
- Future: global session limiter for `--all` wraps multiple `execute_wave_jobs` calls.

## Success criteria

- `cargo test -p agent-ci-core` completes in &lt;5s on CI.
- At least 10 plan fixtures cover matrix, needs, reusable, macOS route, skip-if.
- No file in `agent-ci-core` imports `std::process::Command`.
- TS and Rust both pass fixture CI before RXP-090.

## Open questions

1. Should fixtures live in-repo or a separate `agent-ci-fixtures` git submodule for TS/Rust consumers?
2. Bless snapshots via `insta` crate or committed JSON?
3. When to delete TS `workflow-parser.ts` — after fixture parity or after WASM bindgen eval?

## References

- [rust-execution-parity-plan.md](../rust-execution-parity-plan.md) — RXP-081b concurrency, RXP-090 default switch
- [rust-native-binary-rewrite.md](./rust-native-binary-rewrite.md) — migration strategy
- `scripts/golden-cli-rust.mjs` — existing CLI help contract
- `scripts/rust-smoke-parity.mjs` — end-to-end smoke contract
