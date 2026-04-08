# Running agent-ci inside RivetKit Agent OS

Research document exploring how agent-ci could integrate with [RivetKit Agent OS](https://rivet.dev/docs/agent-os/) by replacing the official GitHub Actions runner with a TypeScript implementation.

> **Status**: Research / exploration. No code yet.

---

## The Idea

Today, agent-ci works like this:

```
agent-ci (orchestrator)
  → Docker container (ubuntu image)
    → Official GitHub Actions runner binary (C#/.NET)
      → Executes steps, evaluates expressions, downloads actions
  → DTU (mock GitHub API, in-process Node server)
```

The proposal: **replace the runner binary with TypeScript** and run directly inside an Agent OS VM. No Docker, no .NET binary, no container orchestration:

```
Agent OS actor (persistent VM)
  → TS runner (in-process)
    → Executes steps via VM shell
    → Evaluates expressions natively
    → Downloads and runs JS actions via Node.js
  → DTU (still useful for action tarball caching)
```

This eliminates:

- Docker daemon dependency
- Container image pulls (~30s cold start)
- Bind mount complexity
- The 150MB .NET runner binary
- Container lifecycle management

And gains:

- **Persistent filesystem** — `/home/user` survives sleep/wake, up to 10GB, no bind mounts needed
- **Durable workflows** — CI runs checkpoint automatically, survive crashes
- **Built-in orchestration** — queues, scheduling, actor-to-actor communication
- **Process management** — exec/spawn with streaming, PTY shells
- **Permission system** — human-in-the-loop or auto-approve for step execution

---

## What the Official Runner Does (and what we'd reimplement)

Based on analysis of how agent-ci seeds jobs and what the runner binary receives:

### 1. Expression Evaluation

The runner evaluates `${{ }}` expressions at step execution time using a `ContextData` object.

**Contexts to support:**

| Context             | Source                               | Complexity                          |
| ------------------- | ------------------------------------ | ----------------------------------- |
| `github.*`          | Constructed from repo metadata       | Low — static values                 |
| `env.*`             | Merged from workflow/job/step `env:` | Low                                 |
| `secrets.*`         | Passed in at run time                | Low                                 |
| `matrix.*`          | From matrix expansion                | Low — agent-ci already does this    |
| `runner.*`          | `os`, `arch`, `temp`, `tool_cache`   | Low — hardcoded values              |
| `steps.*.outputs.*` | From `$GITHUB_OUTPUT` file writes    | Medium                              |
| `needs.*.outputs.*` | From upstream job results            | Medium — agent-ci already does this |
| `needs.*.result`    | success/failure/skipped              | Low — agent-ci already does this    |
| `job.*`             | Container info, status               | Low                                 |
| `inputs.*`          | Workflow dispatch inputs             | Low                                 |

**Functions to support:**

| Function                                            | Complexity                             |
| --------------------------------------------------- | -------------------------------------- |
| `success()`, `failure()`, `always()`, `cancelled()` | Low — check step results               |
| `contains(search, item)`                            | Low                                    |
| `startsWith(str, prefix)` / `endsWith(str, suffix)` | Low                                    |
| `format(fmt, ...args)`                              | Low                                    |
| `join(array, sep)`                                  | Low                                    |
| `toJSON(value)` / `fromJSON(str)`                   | Low                                    |
| `hashFiles(patterns...)`                            | Low — agent-ci already implements this |

**Operators:** `==`, `!=`, `&&`, `||`, `!`, comparisons — need a small expression parser.

**Estimation:** The expression evaluator is the most self-contained piece. It's a small language: property access, function calls, string/number/boolean literals, operators. Could use an existing library or write a ~300-line recursive descent parser.

### 2. Script Step Execution (`run:`)

When a step has `run:`, the runner:

1. Exports all env vars (`env:` from workflow/job/step level, plus `GITHUB_*` variables)
2. Writes the script to a temp file
3. Runs it with the specified shell (default: `bash -e {0}`)
4. Captures exit code
5. Reads workflow command outputs from `$GITHUB_OUTPUT`, `$GITHUB_ENV`, `$GITHUB_PATH`

**In Agent OS:** Use `exec()` or `spawn()` to run shell commands. The VM has a real Linux environment.

```typescript
async function runScriptStep(step: Step, context: RunContext): Promise<StepResult> {
  // Set up environment
  const env = {
    ...context.globalEnv,
    ...step.env,
    GITHUB_OUTPUT: "/tmp/github_output",
    GITHUB_ENV: "/tmp/github_env",
    GITHUB_PATH: "/tmp/github_path",
    GITHUB_STEP_SUMMARY: "/tmp/step_summary",
    GITHUB_WORKSPACE: context.workspace,
  };

  // Evaluate expressions in the script
  const script = evaluateExpressions(step.run, context);

  // Write script to temp file
  const scriptPath = `/tmp/step-${step.id}.sh`;
  await writeFile(scriptPath, script);

  // Execute
  const shell = step.shell ?? "bash -e {0}";
  const cmd = shell.replace("{0}", scriptPath);
  const result = await exec(cmd, { env, cwd: context.workspace });

  // Read outputs
  const outputs = parseOutputFile(await readFile("/tmp/github_output"));
  const envUpdates = parseEnvFile(await readFile("/tmp/github_env"));
  const pathUpdates = parsePathFile(await readFile("/tmp/github_path"));

  return {
    exitCode: result.exitCode,
    outputs,
    envUpdates,
    pathUpdates,
  };
}
```

### 3. Action Execution (`uses:`)

This is the most complex part. Actions come in three types:

#### JavaScript Actions (`runs.using: node20`)

1. Download action tarball (DTU already caches these)
2. Extract to a temp directory
3. Read `action.yml` to find the entry point (`runs.main`)
4. Set up inputs as `INPUT_*` env vars
5. Run `node <entry-point>` with the env vars

```typescript
async function runJsAction(action: Action, inputs: Record<string, string>, context: RunContext) {
  const actionDir = await downloadAndExtract(action.repo, action.ref);
  const actionYml = await readActionYml(actionDir);
  const entryPoint = path.join(actionDir, actionYml.runs.main);

  const env = {
    ...context.globalEnv,
    // Actions read inputs via process.env.INPUT_<NAME>
    ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])),
    GITHUB_ACTION_PATH: actionDir,
  };

  return await exec(`node ${entryPoint}`, { env, cwd: context.workspace });
}
```

**Complexity:** Medium-high. JS actions use `@actions/core`, `@actions/github`, `@actions/exec`, etc. These packages read env vars and write to files — they should "just work" if the env is set up correctly. But some actions do complex things (Docker, network calls, etc.).

#### Composite Actions (`runs.using: composite`)

1. Download and extract
2. Read `action.yml` which contains nested `steps:`
3. Recursively execute each step (can contain `run:` or nested `uses:`)
4. Map inputs/outputs between parent and child

**Complexity:** Medium. It's recursive step execution with input/output mapping.

#### Docker Actions (`runs.using: docker`)

1. Build or pull a Docker image
2. Run the container with inputs as env vars

**Complexity:** High, and **probably not needed for Agent OS**. The whole point is to eliminate Docker. Most popular actions are JS or composite. Docker actions are rare and could be explicitly unsupported.

### 4. Workflow Commands

The runner parses special strings in stdout:

| Command                          | Purpose                      |
| -------------------------------- | ---------------------------- |
| `::set-output name=x::value`     | (deprecated) Set step output |
| `::error file=f,line=l::msg`     | Annotation                   |
| `::warning file=f,line=l::msg`   | Annotation                   |
| `::notice file=f,line=l::msg`    | Annotation                   |
| `::group::name` / `::endgroup::` | Log grouping                 |
| `::add-mask::value`              | Secret masking               |
| `::debug::message`               | Debug log                    |
| `::stop-commands::token`         | Disable command processing   |

**Complexity:** Low. Regex parsing of stdout lines.

### 5. Environment File Commands

Modern GitHub Actions use file-based commands:

| File                   | Purpose                                       |
| ---------------------- | --------------------------------------------- |
| `$GITHUB_OUTPUT`       | `name=value` or `name<<EOF\nvalue\nEOF`       |
| `$GITHUB_ENV`          | Same format, adds to env for subsequent steps |
| `$GITHUB_PATH`         | One path per line, prepended to PATH          |
| `$GITHUB_STATE`        | Step state (for pre/post scripts)             |
| `$GITHUB_STEP_SUMMARY` | Markdown summary                              |

**Complexity:** Low. File parsing with a delimiter protocol.

### 6. Condition Evaluation (`if:`)

Steps and jobs have `if:` conditions:

- `if: success()` — default, run if all previous steps succeeded
- `if: failure()` — run only if a previous step failed
- `if: always()` — always run
- `if: cancelled()` — run if workflow was cancelled
- `if: ${{ steps.check.outputs.skip != 'true' }}`

**Complexity:** Low — reuses the expression evaluator.

### 7. Step Lifecycle

For each step in a job:

1. Evaluate `if:` condition → skip if false
2. If `uses:` action with `pre:` script → run pre
3. Run the step (script or action)
4. Capture outputs, env updates, path updates
5. Update step result (success/failure)
6. If `uses:` action with `post:` script → queue for later
7. After all steps: run queued `post:` scripts in reverse order

---

## What Agent-CI Already Has (reusable)

| Component                        | Location             | Reusable?                                       |
| -------------------------------- | -------------------- | ----------------------------------------------- |
| Workflow YAML parsing            | `workflow-parser.ts` | Yes — uses `@actions/workflow-parser`           |
| Matrix expansion                 | `workflow-parser.ts` | Yes                                             |
| Job dependency graph             | `job-scheduler.ts`   | Yes — topological sort into waves               |
| `if:` condition evaluation       | `workflow-parser.ts` | Partially — basic expressions only              |
| `hashFiles()`                    | `workflow-parser.ts` | Yes                                             |
| Expression expansion             | `workflow-parser.ts` | Partially — handles some contexts               |
| Step wrapping (pause-on-failure) | `step-wrapper.ts`    | Concept reusable, implementation tied to bash   |
| Output capture                   | `step-wrapper.ts`    | Concept reusable                                |
| Action tarball caching           | DTU `cache/`         | Yes — eliminates GitHub CDN downloads           |
| Run state management             | `run-state.ts`       | Maybe — Agent OS state could replace it         |
| Result building                  | `result-builder.ts`  | Partially — timeline parsing is runner-specific |

---

## Implementation Plan

### Phase 1: Script Steps Only (MVP)

Build a TS runner that can execute `run:` steps. No action support yet.

```
Scope: run: steps, env vars, expressions, outputs, conditions
Skip: uses: actions, services, container:, Docker anything
```

**Components:**

1. **Expression evaluator** (~300 lines) — parse and evaluate `${{ }}` with all contexts and functions
2. **Step executor** (~200 lines) — run shell scripts, capture outputs, handle env file commands
3. **Workflow command parser** (~100 lines) — parse `::` commands from stdout
4. **Job runner** (~300 lines) — iterate steps, evaluate conditions, manage context, run pre/post
5. **Orchestrator** (~200 lines) — parse workflow, expand matrices, schedule waves

**Total estimate:** ~1,100 lines of TypeScript for a working MVP.

**What this covers:** A surprising amount of real-world workflows. Many CI pipelines are just `run:` steps:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm install
      - run: npm test
      - run: npm run lint
```

### Phase 2: JavaScript Actions

Add support for `uses:` with JavaScript actions.

**Components:**

1. **Action resolver** — download tarball from GitHub (or DTU cache), extract
2. **action.yml parser** — read entry points, inputs, outputs
3. **JS action executor** — `node <entry>` with INPUT\_\* env vars
4. **@actions/core compatibility** — the env vars and file commands should work automatically

**Key actions to test against:**

- `actions/checkout@v4` — the most used action; clones repo. Could be replaced with a simple `git clone` for local use.
- `actions/setup-node@v4` — installs Node.js. Already available in Agent OS VM.
- `actions/cache@v4` — caches directories. The persistent VM filesystem makes this less important.

### Phase 3: Composite Actions

Add recursive step execution for composite actions.

### Phase 4: Agent OS Integration

Wire the TS runner into Agent OS as an actor:

```typescript
import { actor, setup } from "rivetkit";
import { parseWorkflow, runWorkflow } from "./ts-runner";

const ciActor = actor({
  state: {
    runs: [] as RunResult[],
  },

  actions: {
    runCI: async (c, { workflowPath }: { workflowPath: string }) => {
      const workflow = await parseWorkflow(workflowPath);

      // Each job becomes a durable workflow step
      for (const job of workflow.jobs) {
        const result = await c.workflow.tryStep({
          name: `job-${job.id}`,
          maxRetries: 2,
          run: async () => {
            return await runJob(job, {
              workspace: "/home/user/workspace",
              exec: (cmd, opts) => c.exec(cmd, opts),
            });
          },
        });

        c.state.runs.push(result);
        c.broadcast("job-complete", result);
      }

      return c.state.runs;
    },
  },

  // Queue-driven for async CI triggers
  run: async (c) => {
    for await (const msg of c.queue.iter()) {
      if (msg.name === "run-ci") {
        const result = await c.actions.runCI(msg.body);
        msg.complete(result);
      }
    }
  },
});
```

**What Agent OS adds:**

- **Persistent workspace** — no need to clone every run, files persist across sleep
- **Durable job execution** — if the VM crashes mid-step, it resumes from checkpoint
- **Queued CI triggers** — external systems enqueue runs, actor processes them
- **Realtime streaming** — `c.broadcast()` sends step output to all connected clients
- **Permission gating** — `permissionRequest` events for human-in-the-loop approval
- **Scheduling** — cron-like scheduled CI runs via `c.schedule.at()`
- **Multi-agent** — CI actor can delegate to coding agent actor for fix-and-retry

---

## What We Lose Without the Official Runner

| Feature                 | Impact                                 | Mitigation                                     |
| ----------------------- | -------------------------------------- | ---------------------------------------------- |
| Docker actions          | Can't run `uses:` with `docker://`     | Rare — most popular actions are JS/composite   |
| Service containers      | No `services:` support                 | Run processes directly in VM (`spawn()`)       |
| `container:` directive  | Can't run steps in a different image   | Steps run in VM's native environment           |
| Expression edge cases   | Official runner handles obscure syntax | Cover the common 95% — fail loudly on the rest |
| Runner updates          | GitHub changes runner behavior         | We control our own behavior — feature, not bug |
| `ACTIONS_RUNTIME_TOKEN` | Some actions use internal APIs         | Mock or skip — most don't need this            |

**The big win:** For agent-ci's use case (running CI locally for AI agents), Docker actions and service containers are rarely needed. Most workflows are `run:` steps + `actions/checkout` + `actions/setup-node` + `actions/cache`. A TS runner covering these handles 90%+ of real-world usage.

---

## Architecture Comparison

### Today (with Docker + official runner)

```
agent-ci CLI
├── Workflow parser (TS) ─── @actions/workflow-parser
├── Job scheduler (TS) ──── toposort, concurrency limiter
├── Docker manager (TS) ─── dockerode, container lifecycle
├── DTU server (TS) ─────── mock GitHub API, action cache
└── Container
    ├── Official runner (.NET) ── expression eval, step exec
    ├── Node.js ─────────────── for JS actions
    └── bash ────────────────── for run: steps
```

### Proposed (TS runner in Agent OS)

```
Agent OS Actor
├── Workflow parser (TS) ─── @actions/workflow-parser (reused)
├── Job scheduler (TS) ──── toposort, concurrency (reused)
├── TS Runner (new)
│   ├── Expression evaluator
│   ├── Script step executor ── VM exec()
│   ├── JS action executor ─── VM exec("node ...")
│   ├── Composite action executor
│   ├── Workflow command parser
│   └── Output/env file handler
├── Action cache (simplified DTU or local)
└── Agent OS primitives
    ├── Persistent filesystem (replaces bind mounts)
    ├── Durable workflows (replaces RunStateStore)
    ├── Queues (replaces CLI invocation)
    └── Events (replaces terminal output)
```

---

## Open Questions

1. **Expression evaluator: build or borrow?** There may be existing JS implementations of the GitHub Actions expression syntax. [`actions/languageservices`](https://github.com/actions/languageservices) has an expression parser — could potentially be reused.

2. **`actions/checkout` special-casing?** This action does a full `git clone` with auth. For local dev, a simple `cp -r` or `git clone` from the local repo is better. Should we intercept common actions and provide local-optimized implementations?

3. **Node.js version management?** JS actions specify `runs.using: node20`. The VM needs the right Node version. Agent OS likely has Node available, but version management may be needed.

4. **Can this work without Agent OS?** The TS runner could be valuable standalone — replace Docker in agent-ci even without Agent OS. This de-risks the project: build the runner first, integrate with Agent OS second.

5. **Testing strategy?** Run both the official runner and the TS runner against the same workflows, diff the results. agent-ci's existing test workflows become the test suite.

---

## References

- [Agent OS Quickstart](https://rivet.dev/docs/agent-os/quickstart/)
- [Agent OS Persistence](https://rivet.dev/docs/agent-os/persistence/)
- [Agent OS Sessions](https://rivet.dev/docs/agent-os/sessions/)
- [Agent OS Permissions](https://rivet.dev/docs/agent-os/permissions/)
- [Agent OS Processes](https://rivet.dev/docs/agent-os/processes/)
- [Agent OS Filesystem](https://rivet.dev/docs/agent-os/filesystem/)
- [Agent OS Tools](https://rivet.dev/docs/agent-os/tools/)
- [RivetKit Workflows](https://rivet.dev/docs/actors/workflows/)
- [RivetKit Queues](https://rivet.dev/docs/actors/queues/)
- [RivetKit Schedule](https://rivet.dev/docs/actors/schedule/)
- [GitHub Actions Expression Syntax](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/evaluate-expressions)
- [`actions/languageservices`](https://github.com/actions/languageservices) — official expression parser
