# ts-runner — Compatibility Spec

What's supported, what's not, and where behavior diverges from
the official GitHub Actions runner.

---

## Expressions (`${{ }}`)

### Contexts

| Context                     | Supported | Notes                                                                                                                                                                                        |
| --------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github.*`                  | Yes       | Static values: `actor`, `ref`, `ref_name`, `sha`, `run_id`, `run_number`, `repository`, `workspace`, `server_url`, `api_url`, `event_name`, `event`, `head_sha`, `head_ref`, `action`, `job` |
| `env.*`                     | Yes       | Merged from workflow → job → step level. `GITHUB_ENV` file mutations propagate to subsequent steps.                                                                                          |
| `secrets.*`                 | Yes       | Passed in via `RunWorkflowOptions.secrets`                                                                                                                                                   |
| `matrix.*`                  | Yes       | From matrix expansion. All values coerced to strings.                                                                                                                                        |
| `steps.<id>.outputs.<name>` | Yes       | Populated from `$GITHUB_OUTPUT` file writes and `::set-output` commands                                                                                                                      |
| `steps.<id>.outcome`        | Yes       | Raw result before `continue-on-error`: `success`, `failure`, `skipped`                                                                                                                       |
| `steps.<id>.conclusion`     | Yes       | Final result after `continue-on-error`                                                                                                                                                       |
| `needs.<id>.outputs.<name>` | Yes       | From upstream job output definitions                                                                                                                                                         |
| `needs.<id>.result`         | Yes       | `success`, `failure`, `skipped`                                                                                                                                                              |
| `runner.*`                  | Yes       | `os` = "Linux", `arch` = "X64", `name` = "ts-runner", `temp`, `tool_cache`                                                                                                                   |
| `job.*`                     | Yes       | `status` only                                                                                                                                                                                |
| `inputs.*`                  | Yes       | Workflow dispatch inputs                                                                                                                                                                     |
| `vars.*`                    | No        | Repository/org/environment variables not supported                                                                                                                                           |
| `strategy.*`                | No        | `strategy.fail-fast`, `strategy.job-index`, `strategy.job-total` not exposed                                                                                                                 |

### Operators

| Operator             | Supported | Notes                                                                       |
| -------------------- | --------- | --------------------------------------------------------------------------- |
| `==`                 | Yes       | Case-insensitive string comparison (matches GitHub behavior)                |
| `!=`                 | Yes       | Case-insensitive                                                            |
| `<`, `<=`, `>`, `>=` | Yes       | Numeric comparison when both sides are numbers; string comparison otherwise |
| `&&`                 | Yes       | Short-circuit: returns left operand if falsy                                |
| `\|\|`               | Yes       | Short-circuit: returns left operand if truthy                               |
| `!`                  | Yes       | Boolean negation with GitHub truthiness rules                               |

### Literals

| Type    | Supported | Syntax                                              |
| ------- | --------- | --------------------------------------------------- |
| String  | Yes       | Single-quoted: `'hello'`. Escaped quotes: `'it''s'` |
| Number  | Yes       | Integer and float: `42`, `3.14`. Hex: `0xFF`        |
| Boolean | Yes       | `true`, `false`                                     |
| Null    | Yes       | `null`                                              |

### Functions

| Function                    | Supported | Notes                                                                                                 |
| --------------------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| `success()`                 | Yes       | True when all previous steps have `conclusion` of `success` or `skipped`                              |
| `failure()`                 | Yes       | True when any previous step has `conclusion` of `failure`                                             |
| `always()`                  | Yes       | Always true                                                                                           |
| `cancelled()`               | Yes       | Always false (local runs are never cancelled)                                                         |
| `contains(search, item)`    | Yes       | Case-insensitive. Works on strings and arrays.                                                        |
| `startsWith(str, prefix)`   | Yes       | Case-insensitive                                                                                      |
| `endsWith(str, suffix)`     | Yes       | Case-insensitive                                                                                      |
| `format(template, args...)` | Yes       | `{0}`, `{1}` replacement                                                                              |
| `join(value, separator)`    | Yes       | Separator defaults to `,`                                                                             |
| `toJSON(value)`             | Yes       |                                                                                                       |
| `fromJSON(string)`          | Yes       | Returns parsed value (number, bool, object, etc.)                                                     |
| `hashFiles(patterns...)`    | Yes       | SHA-256 of matching files. Skips `.` dirs and `node_modules`. Returns empty string if no files match. |

### Type coercion

Follows GitHub's rules:

- **To boolean:** `null` → false, `0` → false, `""` → false, `"false"` → false, `"0"` → false, everything else → true
- **To string:** `null` → `""`, `true` → `"true"`, numbers → decimal string, objects → JSON
- **Comparison:** Strings compared case-insensitively. Numbers compared numerically. Mixed string/number attempts numeric coercion.

### Not supported

- Object/array literal syntax in expressions
- `github.event` sub-properties beyond what's set in the base context (e.g. `github.event.pull_request.head.sha` — returns empty unless explicitly provided)
- Property access via `['string']` after a dynamic index (first `[]` works, chained does not)
- `*` wildcard filter syntax (e.g. `needs.*.result`)

---

## Workflow File Features

### Jobs

| Feature                                    | Supported | Notes                                                                       |
| ------------------------------------------ | --------- | --------------------------------------------------------------------------- |
| `jobs.<id>.steps`                          | Yes       | Sequential execution                                                        |
| `jobs.<id>.needs`                          | Yes       | Single string or array. Topological sort into dependency waves.             |
| `jobs.<id>.if`                             | Yes       | Expression evaluation with `needs.*` context. Stripped of `${{ }}` wrapper. |
| `jobs.<id>.name`                           | Yes       | Falls back to job id                                                        |
| `jobs.<id>.env`                            | Yes       | Merged into step env                                                        |
| `jobs.<id>.outputs`                        | Yes       | Expression interpolation of output definitions after all steps complete     |
| `jobs.<id>.strategy.matrix`                | Yes       | Cartesian product of axes, `include`, `exclude`                             |
| `jobs.<id>.timeout-minutes`                | Parsed    | Stored on the Job type but not enforced at job level                        |
| `jobs.<id>.continue-on-error`              | Parsed    | Stored on the Job type but not enforced at job level                        |
| `jobs.<id>.runs-on`                        | Ignored   | Steps run on the host (or Agent OS VM), not in a container                  |
| `jobs.<id>.container`                      | No        | No Docker support                                                           |
| `jobs.<id>.services`                       | No        | No Docker support                                                           |
| `jobs.<id>.concurrency`                    | No        | No concurrency group support                                                |
| `jobs.<id>.permissions`                    | No        | No GITHUB_TOKEN permission scoping                                          |
| `jobs.<id>.environment`                    | No        | No deployment environment support                                           |
| `jobs.<id>.defaults.run.shell`             | No        | Must be set per-step                                                        |
| `jobs.<id>.defaults.run.working-directory` | No        | Must be set per-step                                                        |

### Steps — `run:` (script)

| Feature             | Supported | Notes                                                                           |
| ------------------- | --------- | ------------------------------------------------------------------------------- |
| `run`               | Yes       | Script body, interpolated with `${{ }}`                                         |
| `shell`             | Yes       | `bash` (default), `sh`, `pwsh`, `python`, `node`, custom with `{0}` placeholder |
| `env`               | Yes       | Step-level env vars, interpolated                                               |
| `if`                | Yes       | Defaults to `success()` when omitted                                            |
| `name`              | Yes       | Falls back to `Run <first line of script>`                                      |
| `id`                | Yes       | Used for `steps.<id>.outputs` context. Auto-generated if omitted.               |
| `working-directory` | Yes       | Resolved relative to workspace, interpolated                                    |
| `continue-on-error` | Yes       | Step outcome is `failure` but conclusion becomes `success`                      |
| `timeout-minutes`   | Yes       | SIGTERM after timeout, SIGKILL 5s later                                         |

### Steps — `uses:` (actions)

| Feature | Supported | Notes                                                   |
| ------- | --------- | ------------------------------------------------------- |
| `uses`  | Detected  | Step is logged and **skipped** with a warning. Phase 2. |
| `with`  | Parsed    | Stored on the step but not used yet                     |

### Step output mechanisms

| Mechanism                                | Supported      | Notes                                                                     |
| ---------------------------------------- | -------------- | ------------------------------------------------------------------------- |
| `$GITHUB_OUTPUT` file                    | Yes            | `name=value` single-line and `name<<DELIM` multi-line format              |
| `$GITHUB_ENV` file                       | Yes            | Same format. Mutations apply to subsequent steps.                         |
| `$GITHUB_PATH` file                      | Yes            | One path per line. Prepended to PATH for subsequent steps.                |
| `$GITHUB_STATE` file                     | Ignored        | File is created but not read (pre/post scripts not supported yet)         |
| `$GITHUB_STEP_SUMMARY` file              | Ignored        | File is created but not surfaced                                          |
| `::set-output name=x::value`             | Yes            | Deprecated command, still parsed                                          |
| `::error::`, `::warning::`, `::notice::` | Yes            | Parsed with file/line/col/title properties. Stored in result.             |
| `::debug::`                              | Yes            | Captured in result, not displayed                                         |
| `::add-mask::`                           | Captured       | Masks are recorded but **not applied** to output (output is not redacted) |
| `::group::` / `::endgroup::`             | Passed through | Appear in output but not semantically handled                             |
| `::stop-commands::` / resume             | Yes            | Commands between stop/resume are passed through as plain text             |

---

## Environment Variables

### Set automatically

| Variable              | Value               |
| --------------------- | ------------------- |
| `CI`                  | `true`              |
| `GITHUB_ACTIONS`      | `true`              |
| `GITHUB_WORKSPACE`    | Workspace root path |
| `GITHUB_OUTPUT`       | Temp file path      |
| `GITHUB_ENV`          | Temp file path      |
| `GITHUB_PATH`         | Temp file path      |
| `GITHUB_STATE`        | Temp file path      |
| `GITHUB_STEP_SUMMARY` | Temp file path      |

### NOT set (divergence from official runner)

| Variable                | Why                                                                             |
| ----------------------- | ------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`          | No token generation; pass via secrets if needed                                 |
| `GITHUB_REPOSITORY`     | Available via `${{ github.repository }}` expression but not as a direct env var |
| `GITHUB_SHA`            | Same — expression only                                                          |
| `GITHUB_REF`            | Same                                                                            |
| `GITHUB_RUN_ID`         | Same                                                                            |
| `GITHUB_JOB`            | Same                                                                            |
| `GITHUB_ACTOR`          | Same                                                                            |
| `RUNNER_OS`             | Same                                                                            |
| `RUNNER_ARCH`           | Same                                                                            |
| `RUNNER_TEMP`           | Same                                                                            |
| `RUNNER_TOOL_CACHE`     | Same                                                                            |
| `ACTIONS_RUNTIME_TOKEN` | No runtime token                                                                |
| `ACTIONS_RUNTIME_URL`   | No DTU URL                                                                      |
| `ACTIONS_CACHE_URL`     | No cache service                                                                |

> These could be added as explicit env vars in a future version.
> Currently they are only available through `${{ }}` interpolation.

---

## Matrix Strategy

| Feature        | Supported | Notes                                                   |
| -------------- | --------- | ------------------------------------------------------- |
| Key-value axes | Yes       | Cartesian product of all arrays                         |
| `include`      | Yes       | Merges into matching combo or adds new combo            |
| `exclude`      | Yes       | Removes matching combos                                 |
| `fail-fast`    | No        | All matrix combos run regardless of failures            |
| `max-parallel` | No        | Combos run sequentially (parallel execution is Phase 4) |

Values are coerced to strings. The `matrix.*` context is populated for each combo.

---

## Job Scheduling

| Feature                     | Supported | Notes                                                                               |
| --------------------------- | --------- | ----------------------------------------------------------------------------------- |
| Dependency waves            | Yes       | Jobs topologically sorted by `needs:`. Each wave runs after the previous completes. |
| Parallel jobs in a wave     | No        | Jobs within a wave run sequentially. Parallel is planned for Phase 4.               |
| Upstream failure skipping   | Yes       | If an upstream job fails and the downstream has no custom `if:`, it's skipped.      |
| Upstream failure with `if:` | Yes       | Custom `if:` on downstream job overrides the default skip behavior.                 |
| Circular dependencies       | Handled   | Detected and broken (remaining jobs run in a final wave).                           |

---

## Known Divergences from Official Runner

1. **No `GITHUB_*` env vars by default.** The official runner exports ~30 env vars. ts-runner only sets `CI`, `GITHUB_ACTIONS`, `GITHUB_WORKSPACE`, and the file command paths. Other values are available through `${{ }}` but not as direct env vars. This means `echo $GITHUB_SHA` won't work but `echo ${{ github.sha }}` will.

2. **Case-insensitive `==` comparison.** This matches GitHub's documented behavior, but some users expect case-sensitive comparison. The official runner is also case-insensitive.

3. **`cancelled()` is always false.** There's no cancellation mechanism in local runs.

4. **Secret masking is not applied.** `::add-mask::` values are captured but stdout/stderr output is not redacted. Secrets may appear in logs.

5. **No `ACTIONS_RUNTIME_TOKEN`.** Actions that call GitHub's internal APIs (artifact upload, cache, OIDC) will fail. This affects `actions/cache`, `actions/upload-artifact`, etc.

6. **Process environment leaks into steps.** The official runner runs in a clean container. ts-runner inherits `process.env` from the host, meaning steps see the host's PATH, HOME, etc. This can cause "works on my machine" issues.

7. **Shell default is `bash`, not the runner's default.** The official runner uses `bash --noprofile --norc -eo pipefail {0}` on Linux and `pwsh` on Windows. ts-runner always defaults to `bash` since it runs on the host.

---

## What Will Never Be Supported

| Feature                                                           | Reason                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------- |
| Docker actions (`runs.using: docker`)                             | Entire point is to eliminate Docker                           |
| `container:` directive                                            | Same                                                          |
| `services:` directive                                             | Same (could be added as host processes in a future version)   |
| Runner groups / labels                                            | No runner registration; steps run locally                     |
| Reusable workflows (`uses: org/repo/.github/workflows/x.yml@ref`) | Would require downloading and parsing external workflow files |
| OIDC token generation                                             | No identity provider                                          |
