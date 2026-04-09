# YAML Compatibility

Agent CI aims to run real GitHub Actions workflows locally. The table below shows current support against the [official workflow syntax](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions).

✅ = Supported &nbsp; ⚠️ = Partial &nbsp; ❌ = Not supported &nbsp; 🟡 = Ignored (no-op)

## Workflow-Level Keys

| Key                                | Status | Notes                                                                                                                                                                                                 |
| ---------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                             | ✅     |                                                                                                                                                                                                       |
| `run-name`                         | 🟡     | Parsed but not displayed anywhere                                                                                                                                                                     |
| `on` (push, pull_request)          | ✅     | Branch and path filters are evaluated when using `--all`                                                                                                                                              |
| `on` (schedule, workflow_dispatch) | 🟡     | Accepted without error, but Agent CI does not simulate event triggers — workflows must be run manually                                                                                                |
| `on` (workflow_call)               | ⚠️     | Local reusable workflows (`uses: ./.github/workflows/...`) are inlined into the caller's dependency graph. Remote refs, `inputs:`/`outputs:` passing, and nested reusable workflows are not supported |
| `on` (other events)                | 🟡     | Parsed without error, but the event is not simulated                                                                                                                                                  |
| `env`                              | ✅     | Workflow-level env is propagated to all steps                                                                                                                                                         |
| `defaults.run.shell`               | ✅     | Passed through to the runner                                                                                                                                                                          |
| `defaults.run.working-directory`   | ✅     | Passed through to the runner                                                                                                                                                                          |
| `permissions`                      | 🟡     | Accepted but not enforced — the mock GITHUB_TOKEN has full access                                                                                                                                     |
| `concurrency`                      | ❌     | Concurrency groups are a GitHub-side queuing and cancellation mechanism. Agent CI has no persistent server to track group state across runs, so this cannot be implemented locally                    |

## Job-Level Keys

| Key                                   | Status | Notes                                                                                                                                                                                                                        |
| ------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobs.<id>`                           | ✅     | Multiple jobs in a single workflow                                                                                                                                                                                           |
| `jobs.<id>.name`                      | ✅     |                                                                                                                                                                                                                              |
| `jobs.<id>.needs`                     | ✅     | Jobs are sorted topologically into dependency waves                                                                                                                                                                          |
| `jobs.<id>.if`                        | ⚠️     | Supported: `success()`, `failure()`, `always()`, `cancelled()`, `==`/`!=`, `&&`/`\|\|`, `needs.*.outputs.*`, `needs.*.result`. Not supported: `contains()`, `startsWith()`, `endsWith()`, unary `!`, and numeric comparisons |
| `jobs.<id>.runs-on`                   | 🟡     | Accepted but always runs in a Linux container regardless of the value                                                                                                                                                        |
| `jobs.<id>.environment`               | 🟡     | Accepted but not enforced — environment protection rules are GitHub-side only                                                                                                                                                |
| `jobs.<id>.env`                       | ✅     |                                                                                                                                                                                                                              |
| `jobs.<id>.defaults.run`              | ✅     | `shell` and `working-directory`                                                                                                                                                                                              |
| `jobs.<id>.outputs`                   | ✅     | Resolved after each job completes and accumulated across dependency waves                                                                                                                                                    |
| `jobs.<id>.timeout-minutes`           | ❌     | Not implemented. Agent CI's pause-on-failure model is the intended way to handle long-running steps — a hard timeout would destroy the container state that makes local debugging possible                                   |
| `jobs.<id>.continue-on-error`         | ❌     | Not implemented. Agent CI pauses on failure so you can inspect and fix the container in place; `continue-on-error` would skip past failures and discard that debugging opportunity                                           |
| `jobs.<id>.concurrency`               | ❌     | See workflow-level `concurrency` above                                                                                                                                                                                       |
| `jobs.<id>.container`                 | ✅     | Short and long form; image, env, ports, volumes, and options are all supported                                                                                                                                               |
| `jobs.<id>.services`                  | ✅     | Sidecar containers with image, env, ports, and options                                                                                                                                                                       |
| `jobs.<id>.uses` (reusable workflows) | ⚠️     | Local refs (`./`) are expanded inline. Remote refs are skipped with a warning. `with:` (inputs) and `secrets:` pass-through are not yet supported                                                                            |
| `jobs.<id>.secrets`                   | ❌     | Agent CI cannot access GitHub's secret storage. Use a `.env.agent-ci` file at the project root instead — secrets are loaded from there and injected as `${{ secrets.* }}` expressions                                        |

## Strategy / Matrix

| Key                       | Status | Notes                                                                                                                                                                                               |
| ------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strategy.matrix`         | ✅     | Cartesian product of all array values is fully expanded                                                                                                                                             |
| `strategy.matrix.include` | ❌     | Not implemented. The matrix parser only processes array-valued keys; `include` entries (which are objects) are silently dropped. Adding support would require post-processing the Cartesian product |
| `strategy.matrix.exclude` | ❌     | Not implemented — same reason as `include`. `exclude` entries are objects and are dropped by the array-only parser                                                                                  |
| `strategy.fail-fast`      | ✅     | Setting `fail-fast: false` allows remaining matrix jobs to continue after a failure                                                                                                                 |
| `strategy.max-parallel`   | ❌     | Not implemented. Parallelism is controlled by Agent CI's host-level concurrency limiter (based on CPU count), not per-workflow job limits                                                           |

## Step-Level Keys

| Key                          | Status | Notes                                                                                                                                                                                                                                                       |
| ---------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `steps[*].id`                | ✅     |                                                                                                                                                                                                                                                             |
| `steps[*].name`              | ✅     | Expression expansion in names                                                                                                                                                                                                                               |
| `steps[*].if`                | ⚠️     | The condition is passed to the official runner binary, which evaluates it at runtime. Limitation: `steps.*.outputs.cache-hit` and similar outputs resolve to an empty string at parse time because prior steps have not yet run when the workflow is parsed |
| `steps[*].run`               | ✅     | Multiline shell scripts with `${{ }}` expression expansion                                                                                                                                                                                                  |
| `steps[*].uses`              | ✅     | Public actions are downloaded via the GitHub API                                                                                                                                                                                                            |
| `steps[*].uses` (local `./`) | ❌     | Local actions defined inside the repo are not supported. Agent CI fails immediately with a clear error rather than silently producing wrong results                                                                                                         |
| `steps[*].with`              | ✅     | Expression expansion in values                                                                                                                                                                                                                              |
| `steps[*].env`               | ✅     | Expression expansion in values                                                                                                                                                                                                                              |
| `steps[*].working-directory` | ✅     |                                                                                                                                                                                                                                                             |
| `steps[*].shell`             | ✅     | Passed through to the runner                                                                                                                                                                                                                                |
| `steps[*].continue-on-error` | ❌     | Not implemented — see `jobs.<id>.continue-on-error` above for the reasoning                                                                                                                                                                                 |
| `steps[*].timeout-minutes`   | ❌     | Not implemented — see `jobs.<id>.timeout-minutes` above for the reasoning                                                                                                                                                                                   |

## Expressions (`${{ }}`)

| Expression                                          | Status | Notes                                                                                                                                                                         |
| --------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hashFiles(...)`                                    | ✅     | SHA-256 of matching files; supports multiple glob patterns                                                                                                                    |
| `format(...)`                                       | ✅     | Template substitution with recursive expression expansion                                                                                                                     |
| `matrix.*`                                          | ✅     |                                                                                                                                                                               |
| `secrets.*`                                         | ✅     | Loaded from `.env.agent-ci` at the project root                                                                                                                               |
| `runner.os`                                         | ✅     | Always returns `Linux`                                                                                                                                                        |
| `runner.arch`                                       | ✅     | Always returns `X64`                                                                                                                                                          |
| `github.sha`, `github.ref_name`, etc.               | ⚠️     | Returns hardcoded dummy values: `sha` is all zeros, `ref_name` and `head_ref` are `main`, `repository` is `local/repo`, `actor` is `local`, `run_id` and `run_number` are `1` |
| `github.event.*`                                    | ⚠️     | All event payload fields return empty strings — no real webhook event is triggered locally                                                                                    |
| `strategy.job-total`, `strategy.job-index`          | ✅     |                                                                                                                                                                               |
| `steps.*.outputs.*`                                 | ⚠️     | Resolves to an empty string at parse time. The official runner evaluates these correctly at runtime — the limitation only affects Agent CI's own expression pre-processing    |
| `needs.*.outputs.*`                                 | ✅     | Resolved after dependency jobs complete. The needs context is built from actual job outputs and passed into subsequent job evaluation                                         |
| Boolean/comparison operators                        | ⚠️     | Supported in job-level `if`: `==`, `!=`, `&&`, `\|\|`, parentheses. Not supported: unary `!`, numeric comparisons (`<`, `>`, `<=`, `>=`)                                      |
| `toJSON`, `fromJSON`                                | ✅     |                                                                                                                                                                               |
| `contains`, `startsWith`, `endsWith`                | ❌     | Not implemented in the expression parser. The evaluator handles context lookups and comparison operators but does not support arbitrary function calls with string arguments  |
| `success()`, `failure()`, `always()`, `cancelled()` | ✅     | Evaluated by Agent CI for job-level `if` conditions                                                                                                                           |

## GitHub API Features (DTU Mock)

| Feature                                                 | Status | Notes                                                                                                                 |
| ------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| Action downloads                                        | ✅     | Action tarballs are resolved and downloaded from github.com                                                           |
| `actions/cache`                                         | ✅     | Cache is stored on the local filesystem via bind-mount, giving ~0 ms round-trip on cache hits                         |
| `actions/checkout`                                      | ✅     | The workspace is rsynced into the container with `clean: false` to preserve local changes                             |
| `actions/setup-node`, `actions/setup-python`, etc.      | ✅     | Tool setup actions run natively inside the runner container                                                           |
| `actions/upload-artifact` / `download-artifact`         | ✅     | Artifacts are stored on the local filesystem                                                                          |
| `GITHUB_TOKEN`                                          | ✅     | A mock token is injected; all GitHub API calls from the runner are answered locally by Agent CI's API emulation layer |
| Workflow commands (`::set-output::`, `::error::`, etc.) | ✅     | Handled by the official runner binary                                                                                 |
