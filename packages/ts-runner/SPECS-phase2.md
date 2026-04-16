# ts-runner Phase 2 — Behavioral Specs

Black-box specs derived from issue #134 intent. Every scenario is verifiable
using only external interfaces: workflow execution results, file system state,
process exit codes, and network port availability. No internal implementation
details appear in any spec.

---

## Spec Area 1: `actions/checkout@v4` — Action Resolution & Workspace Population

### Spec 1.1 — Checkout step succeeds and workspace contains repository files

**Given:**
A workflow with a single job whose only step is `uses: actions/checkout@v4`.

**When:**
The runner executes the workflow.

**Then:**
- The step exits with success status.
- The working directory contains the repository's file tree (files that exist in
  the repo are present on disk after the step).

---

### Spec 1.2 — A `run:` step following checkout can read checked-out files

**Given:**
A workflow with two steps:
- Step 1: `uses: actions/checkout@v4`
- Step 2: a shell step that lists the working directory (e.g. `ls`)

**When:**
The runner executes the workflow.

**Then:**
- Both steps complete with success status.
- Step 2 produces non-empty output (files are present in the working directory).

---

### Spec 1.3 — Second run of the same action does not fail due to missing cache

**Given:**
A workflow with `uses: actions/checkout@v4` is run once (action resolved
successfully). The action's resolved copy is now available locally.

**When:**
The same workflow is run again without clearing any local state.

**Then:**
- The step completes with success status on the second run.

---

## Spec Area 2: JS Action Output Setting

### Spec 2.1 — Action output set during execution is available to subsequent steps

**Given:**
A workflow job with two steps:
- Step 1 (`id: setter`) uses a local JS action whose main script sets an output
  named `greeting` to the value `hello`.
- Step 2 is a `run:` step that echoes `${{ steps.setter.outputs.greeting }}`.

**When:**
The runner executes the workflow.

**Then:**
- Both steps complete with success status.
- Step 2 prints `hello` (the value set by the action in step 1).

---

### Spec 2.2 — Multiple outputs set in one action invocation are all accessible

**Given:**
A workflow job with:
- Step 1 (`id: multi`) uses a JS action that sets two outputs: `a=foo` and
  `b=bar`.
- Step 2 is a `run:` step that echoes both `${{ steps.multi.outputs.a }}` and
  `${{ steps.multi.outputs.b }}`.

**When:**
The runner executes the workflow.

**Then:**
- Step 2 prints `foo` and `bar` (both outputs are accessible).

---

## Spec Area 3: `INPUT_*` Environment Variable Mapping

### Spec 3.1 — `with:` values are delivered to the action as `INPUT_<UPPERCASED_KEY>` env vars

**Given:**
A workflow step uses a local JS action with `with: { token: "abc123" }`. The
action's main script reads the `INPUT_TOKEN` environment variable and writes it
to an output named `received`.

**When:**
The runner executes the step.

**Then:**
- The action receives the environment variable `INPUT_TOKEN` set to `abc123`.
- The output `received` equals `abc123`.

---

### Spec 3.2 — Multi-word input key is uppercased and hyphen/underscore-normalised

**Given:**
A workflow step uses a local JS action with `with: { my-key: "value99" }`. The
action reads `INPUT_MY-KEY` (or the normalised form `INPUT_MY_KEY` per GitHub
Actions conventions) and writes it to an output named `received`.

**When:**
The runner executes the step.

**Then:**
- The output `received` equals `value99`.

---

### Spec 3.3 — Default values from action manifest apply when caller omits the key

**Given:**
A local JS action's manifest defines an input `color` with `default: red`. The
workflow step that uses the action does not specify `color` in `with:`. The
action reads its `color` input and writes it to an output.

**When:**
The runner executes the step.

**Then:**
- The output equals `red` (the manifest default was applied).

---

### Spec 3.4 — Missing required input causes the step to fail before execution

**Given:**
A local JS action's manifest defines an input `token` marked `required: true`
with no default value. The workflow step that uses the action does not provide
`token` in `with:`.

**When:**
The runner attempts to execute the step.

**Then:**
- The step reports a failure status.
- The action's main script is never invoked (no side-effects from its execution
  appear on disk or in outputs).
- The job exits with a failure result.

---

## Spec Area 4: Pre/Post Script Execution Order

### Spec 4.1 — Pre-step runs before the action's main script

**Given:**
A local JS action has both a `pre` script and a `main` script:
- Pre script appends the string `pre` on its own line to a file called
  `order.txt` in the workspace.
- Main script appends the string `main` on its own line to the same file.

The workflow has one step that uses this action, followed by a `run:` step that
prints the contents of `order.txt`.

**When:**
The runner executes the workflow.

**Then:**
- `order.txt` contains `pre` on the first line and `main` on the second line.
- The `run:` step output confirms this ordering.

---

### Spec 4.2 — Post-step runs after all main job steps have completed

**Given:**
A workflow job with two steps:
- Step 1 uses a JS action whose main script appends `main-A` to `order.txt`,
  and whose post script appends `post-A` to `order.txt`.
- Step 2 is a `run:` step that appends `step-2` to `order.txt`.

**When:**
The runner completes all steps and then runs post scripts.

**Then:**
- `order.txt` contains lines in the order: `main-A`, `step-2`, `post-A`.
- `post-A` appears after `step-2` (post ran only after all main steps finished).

---

### Spec 4.3 — Multiple post scripts run in reverse registration order

**Given:**
A workflow job with three steps:
- Step 1 uses action A, which has a post script that appends `post-A` to
  `order.txt`.
- Step 2 uses action B, which has a post script that appends `post-B` to
  `order.txt`.
- Step 3 is a plain `run:` step (no post).

Action A is registered (and its post queued) before action B.

**When:**
The runner finishes all three steps and executes the post queue.

**Then:**
- `order.txt` contains `post-B` before `post-A` (reverse of registration order:
  B was registered last, so its post runs first).

---

## Spec Area 5: Postgres Service Container on `localhost:5432`

### Spec 5.1 — Service container is running before the first job step executes

**Given:**
A workflow job with a `services` block:
```yaml
services:
  postgres:
    image: postgres:16
    env:
      POSTGRES_PASSWORD: test
    ports:
      - 5432:5432
    options: >-
      --health-cmd pg_isready
      --health-interval 10s
      --health-timeout 5s
      --health-retries 5
```
The first (and only) step attempts a TCP connection to `localhost:5432`.

**When:**
The runner starts the job.

**Then:**
- The TCP connection attempt in the first step succeeds (the service is fully
  started and healthy before any steps run).
- The step exits with success status.

---

### Spec 5.2 — Steps can connect to the Postgres service at `localhost:5432`

**Given:**
The same Postgres service configuration as Spec 5.1. The workflow contains a
`run:` step that runs a connectivity check to `localhost:5432` (e.g. using
`pg_isready -h localhost -p 5432` or an equivalent TCP probe).

**When:**
The runner executes the step.

**Then:**
- The connectivity check reports success.
- The step exits with code 0.

---

### Spec 5.3 — Service is accessible for the full duration of the job

**Given:**
A workflow job with a Postgres service and multiple steps that each connect to
`localhost:5432` at different points during execution.

**When:**
The runner executes all steps.

**Then:**
- Every step that attempts a connection to `localhost:5432` succeeds.
- The service remains available until after all steps complete.

---

## Spec Area 6: Service Container Cleanup and Orphan Pruning

### Spec 6.1 — Service containers are force-removed after a successful job

**Given:**
A workflow job with a service container; all steps complete successfully.

**When:**
The runner finishes the job.

**Then:**
- The service container is no longer present (removed, not merely stopped).
- The port binding used by the service is released.
- The workflow result indicates success.

---

### Spec 6.2 — Service containers are force-removed after a failed job

**Given:**
A workflow job with a service container; at least one step fails.

**When:**
The runner finishes the job (failure result).

**Then:**
- The service container is still removed despite the job failure (cleanup is
  unconditional).
- The workflow result indicates failure.

---

### Spec 6.3 — Orphan containers from a previous crashed run are pruned before the new run begins

**Given:**
Docker already has one or more running or stopped containers whose names match
the `ts-runner-svc-*` pattern, left over from a previous run that crashed
without cleaning up.

**When:**
A new workflow run is started (before any steps of the new run execute).

**Then:**
- The orphan containers are removed before the new run's first step executes.
- The new run proceeds normally with its own freshly-created containers.

---

### Spec 6.4 — Orphan cleanup is non-destructive toward unrelated containers

**Given:**
Docker has containers whose names do NOT match the `ts-runner-svc-*` pattern
running alongside an orphan ts-runner container.

**When:**
The runner starts and performs orphan cleanup.

**Then:**
- Only containers whose names match `ts-runner-svc-*` are removed.
- Unrelated containers are left running and untouched.

---

## Notes for Test Writing

1. **Action fixtures**: Specs in Areas 2–4 require local JS action fixtures (a
   minimal `action.yml` + a `main.js`). Tests should create these in a temp
   directory rather than checking a pre-built action into the repo.

2. **Service container specs** (Areas 5–6) require Docker to be available. These
   tests should be tagged or placed in a separate suite so they can be skipped in
   environments without Docker.

3. **Port availability**: Spec 5.x assumes port 5432 is available on the test
   host. Tests should fail gracefully (or skip) if the port is already bound.

4. **Orphan cleanup** (Spec 6.3–6.4) requires creating Docker containers with
   the expected name pattern before invoking the runner. Tests should clean up
   any containers they create in `afterEach`.

5. **File ordering** (Area 4 specs) uses an `order.txt` file in the workspace to
   capture execution sequence. Tests should create a fresh temporary workspace
   for each test case.
