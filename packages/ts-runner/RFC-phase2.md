# RFC: ts-runner Phase 2 — JavaScript Actions & Service Containers

**Date**: 2026-04-16  
**Status**: Draft (awaiting review)  
**Author**: Developer agent

---

## Phase 1 State Summary

**Finding**: Phase 1 was **never implemented** in this repository. `PLAN.md` marks Phase 1 as "DONE" with 57 passing tests, but this is aspirational — the commit history reveals only two commits (`e19997e` and `5e9d177`). The earlier commit introduced only the scaffolding: `PLAN.md`, `SPEC.md`, `package.json`, `tsconfig.json`, and `src/index.ts` (which exports `VERSION = "0.7.0"`). No implementation files exist: `expressions.ts`, `commands.ts`, `step-executor.ts`, `workflow-parser.ts`, `job-runner.ts`, `runner.ts`, `types.ts`, and `cli.ts` are all absent.

**Evidence**:
- `ls packages/ts-runner/src/` → only `index.ts`
- `git log --all --oneline` → two commits; `git show e19997e --stat | grep ts-runner` → confirms only scaffolding was committed
- `packages/ts-runner/package.json` → only `yaml` runtime dependency; `tsx` dev-only; no `@types/dockerode` or `dockerode`

**Impact on Phase 2**: Phase 2 modules (`action-resolver.ts`, `action-executor.ts`, `service-containers.ts`) integrate with Phase 1's job runner and step executor. They cannot be **exercised end-to-end** until Phase 1 exists. However, Phase 2 modules can be implemented with well-defined interfaces so that Phase 1 integration is a matter of calling the Phase 2 API from Phase 1's job runner.

**Decision**: This RFC includes `types.ts` as a Phase 2 deliverable that establishes the shared contract between Phase 1 and Phase 2 modules. Phase 2 modules are authored against these types and are ready for integration once Phase 1 is implemented.

---

## 2000ft View Narrative

Phase 2 adds two capabilities to the ts-runner: *JavaScript action execution* and *Docker service containers*.

**JS actions**: When a workflow step uses `uses: owner/repo@ref`, Phase 2 downloads the action tarball (sharing the tarball cache with the existing DTU), extracts it, reads its `action.yml` metadata, and runs the action's entry point via `node <main>` with proper `INPUT_*` environment variables, `GITHUB_ACTION_PATH`, and all standard GitHub Actions environment variables. If the action defines a `runs.pre` script, it runs before the main step; if it defines `runs.post`, that is queued and runs after all steps complete in reverse order. Three common actions (`actions/checkout`, `actions/setup-node`, `actions/cache`) are intercepted before any download and handled with lightweight local equivalents.

**Service containers**: When a workflow job defines a `services:` block, Phase 2 creates Docker containers (via dockerode), waits for them to be healthy, injects connection env vars into step environments, and force-removes them after the job — regardless of success or failure. Stale containers from previous crashed runs are pruned on startup. Steps reach services via `localhost:<port>`, not by service hostname (documented divergence from GitHub Actions).

---

## File Inventory

| File | Status | Description |
|------|--------|-------------|
| `src/types.ts` | **[NEW]** | All shared TypeScript interfaces: `Workflow`, `Job`, `Step`, `StepResult`, `JobResult`, `RunContext`, `ActionManifest`, `ServiceDef`, `RunningService`, `PrePostEntry` |
| `src/action-resolver.ts` | **[NEW]** | Given `owner/repo@ref`, return path to extracted action directory; implements tarball cache using same dir as DTU |
| `src/action-parser.ts` | **[NEW]** | Parse `action.yml` into `ActionManifest`; validate shape; resolve `uses: node20/node16` etc. |
| `src/action-executor.ts` | **[NEW]** | Execute a JS action step: resolve → parse → validate inputs → run pre → run main → queue post; return `StepResult` |
| `src/builtin-actions.ts` | **[NEW]** | Override handlers for `actions/checkout`, `actions/setup-node`, `actions/cache`; checked before download |
| `src/service-containers.ts` | **[NEW]** | Full Docker lifecycle: startup, health polling, env injection, teardown, orphan cleanup |
| `src/pre-post-queue.ts` | **[NEW]** | Post-step queue data structure (pre is executed inline; post is collected and flushed at job end) |
| `src/index.ts` | **[MODIFY]** | Export Phase 2 public API (`executeActionStep`, `ServiceContainerManager`, `PrePostQueue`) |
| `packages/ts-runner/package.json` | **[MODIFY]** | Add `dockerode@^4.0.2`, `@types/dockerode@^3.3.34` |

---

## Type Definitions

```typescript
// src/types.ts

// ─── Phase 1 types (defined here as contract for Phase 2 integration) ─────────

export interface WorkflowTriggers {
  push?: { branches?: string[] };
  pull_request?: { branches?: string[] };
  workflow_dispatch?: { inputs?: Record<string, WorkflowInput> };
  [key: string]: unknown;
}

export interface WorkflowInput {
  description?: string;
  required?: boolean;
  default?: string;
  type?: 'string' | 'boolean' | 'choice' | 'number';
  options?: string[];
}

export interface WorkflowEnv {
  [key: string]: string;
}

export interface Workflow {
  name?: string;
  on: WorkflowTriggers;
  env?: WorkflowEnv;
  jobs: Record<string, Job>;
}

export interface Job {
  id: string;
  name?: string;
  runsOn: string | string[];
  needs?: string | string[];
  if?: string;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  strategy?: MatrixStrategy;
  services?: Record<string, ServiceDef>;
  steps: Step[];
  continueOnError?: boolean;
  timeoutMinutes?: number;
}

export interface MatrixStrategy {
  matrix: Record<string, unknown[]>;
  include?: Record<string, unknown>[];
  exclude?: Record<string, unknown>[];
  failFast?: boolean;
  maxParallel?: number;
}

export interface Step {
  id?: string;
  name?: string;
  uses?: string;                   // 'owner/repo@ref' or './local/path'
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
  if?: string;
  continueOnError?: boolean;
  timeoutMinutes?: number;
  workingDirectory?: string;
  shell?: string;
}

export interface Annotation {
  type: 'error' | 'warning' | 'notice' | 'debug';
  message: string;
  file?: string;
  line?: number;
  col?: number;
  title?: string;
}

export interface StepResult {
  id: string;
  name: string;
  outcome: 'success' | 'failure' | 'skipped';
  conclusion: 'success' | 'failure' | 'skipped';
  outputs: Record<string, string>;
  /** env mutations to propagate to subsequent steps */
  env: Record<string, string>;
  /** PATH prepend entries to carry forward */
  path: string[];
  annotations: Annotation[];
}

export interface JobResult {
  id: string;
  name: string;
  outcome: 'success' | 'failure' | 'skipped';
  outputs: Record<string, string>;
  steps: StepResult[];
}

export interface WorkflowResult {
  outcome: 'success' | 'failure';
  jobs: Record<string, JobResult>;
}

export interface RunnerInfo {
  os: 'Linux' | 'Windows' | 'macOS';
  arch: 'X64' | 'ARM64';
  name: string;
  temp: string;
  toolCache: string;
}

/** Full expression evaluation context — passed through job execution */
export interface RunContext {
  github: {
    actor?: string;
    ref?: string;
    ref_name?: string;
    sha?: string;
    run_id?: string;
    run_number?: string;
    repository?: string;
    workspace?: string;
    server_url?: string;
    api_url?: string;
    event_name?: string;
    event?: Record<string, unknown>;
    head_sha?: string;
    head_ref?: string;
    action?: string;
    job?: string;
    token?: string;
  };
  env: Record<string, string>;
  secrets: Record<string, string>;
  matrix: Record<string, string>;
  steps: Record<string, StepResult>;
  needs: Record<string, { outputs: Record<string, string>; result: string }>;
  runner: RunnerInfo;
  job: { status: string };
  inputs: Record<string, string>;
  /** Absolute path of the workspace on disk */
  workspace: string;
  /** Current PATH entries (accumulated from GITHUB_PATH file writes) */
  pathEntries: string[];
  /** Merged file-command env accumulator (from GITHUB_ENV file writes) */
  fileEnv: Record<string, string>;
}

export interface RunWorkflowOptions {
  workflowPath: string;
  workspace?: string;
  env?: Record<string, string>;
  secrets?: Record<string, string>;
  inputs?: Record<string, string>;
  matrix?: Record<string, string>;
  /** DTU base URL — enables ACTIONS_RUNTIME_TOKEN/URL env vars */
  dtuUrl?: string;
  /** Override tarball cache dir (default: DTU_CACHE_DIR env → ~/.cache/ts-runner) */
  tarballCacheDir?: string;
  onJobStart?: (jobId: string, jobName: string) => void;
  onJobEnd?: (jobId: string, result: JobResult) => void;
  onStepStart?: (jobId: string, stepId: string, stepName: string) => void;
  onStepEnd?: (jobId: string, stepId: string, result: StepResult) => void;
}

// ─── Phase 2 types ────────────────────────────────────────────────────────────

/** Parsed action.yml metadata */
export interface ActionManifest {
  name: string;
  description?: string;
  author?: string;
  inputs?: Record<string, ActionInput>;
  outputs?: Record<string, ActionOutput>;
  runs: ActionRuns;
}

export interface ActionInput {
  description?: string;
  required?: boolean;
  default?: string;
}

export interface ActionOutput {
  description?: string;
  /** For composite action outputs: expression referencing steps context */
  value?: string;
}

export type ActionRuns =
  | NodeActionRuns
  | CompositeActionRuns
  | DockerActionRuns;

export interface NodeActionRuns {
  using: 'node20' | 'node16' | 'node12';
  main: string;
  pre?: string;
  preIf?: string;
  post?: string;
  postIf?: string;
}

export interface CompositeActionRuns {
  using: 'composite';
  steps: Step[];
}

export interface DockerActionRuns {
  using: 'docker';
  image: string;
  entrypoint?: string;
  args?: string[];
}

/** Service container definition from workflow YAML */
export interface ServiceDef {
  /** Service name (key in services: block) */
  id: string;
  image: string;
  env?: Record<string, string>;
  /** Port mappings: ['5432:5432', '6379:6379'] */
  ports?: string[];
  /** Raw options string (--health-cmd etc.) */
  options?: string;
}

/** Parsed health-check options from --health-cmd / --health-interval etc. */
export interface HealthCheckOptions {
  cmd?: string;
  intervalMs?: number;
  timeoutMs?: number;
  retries?: number;
}

/** Runtime state of a running service container */
export interface RunningService {
  /** Service name from workflow */
  id: string;
  /** Docker container ID */
  containerId: string;
  /** containerPort → hostPort */
  hostPorts: Record<number, number>;
  /** Env forwarded from ServiceDef */
  env: Record<string, string>;
}

/** Entry in the post-step queue */
export interface PrePostEntry {
  type: 'post';
  /** Absolute path to the extracted action directory */
  actionDir: string;
  /** Relative path of the script within actionDir */
  scriptPath: string;
  /** Resolved INPUT_* env vars (captured at registration time) */
  inputEnv: Record<string, string>;
  /** Step ID for context propagation */
  stepId: string;
  /** Step name for display */
  stepName: string;
}

/** Result of executing an action step (extends StepResult with Phase 2 metadata) */
export interface ActionStepResult extends StepResult {
  /** Post-step entry to enqueue after this step completes successfully */
  postEntry?: PrePostEntry;
}
```

---

## Dependency Changes

### `packages/ts-runner/package.json`

Add to `dependencies`:
```json
"dockerode": "^4.0.2"
```

Add to `devDependencies`:
```json
"@types/dockerode": "^3.3.34"
```

Both are already present in `packages/cli/package.json` at the same versions and are in `pnpm-lock.yaml` (`dockerode@4.0.9`, `@types/dockerode@3.3.47`). pnpm will deduplicate them in `node_modules`.

---

## Action Resolver Design (`src/action-resolver.ts`)

### Tarball Cache Location

ts-runner shares the DTU's tarball cache. The cache directory is resolved in this priority order:

1. `options.tarballCacheDir` (explicit override)
2. `process.env.DTU_CACHE_DIR` + `/action-tarballs` (same env var as DTU)
3. `os.homedir()/.cache/ts-runner/action-tarballs` (standalone default)

The file naming matches the DTU's naming scheme exactly (enabling cache sharing):
```
${owner}__${repo}@${sanitizedRef}.tar.gz
```
where `sanitizedRef = ref.replace(/[^a-zA-Z0-9._-]/g, '-')`.

### Extracted Action Cache

Alongside the tarball cache, an extracted directory cache avoids re-extracting:
```
$CACHE_BASE/extracted/${owner}__${repo}@${sanitizedRef}/
```

If the extracted dir already exists, no tarball download or extraction is needed.

### Download Algorithm

```
resolveAction(actionRef: string, opts: ResolverOptions): Promise<string>

  1. Parse 'owner/repo@ref' → { owner, repo, ref }
     - Validate format: must contain '/' and '@'
     - Extract sub-path if present ('actions/cache/save' → repo='cache', subPath='save')
  
  2. extractedDir = path.join(extractedCacheDir, `${owner}__${repo}@${sanitizedRef}`)
     If fs.existsSync(extractedDir): return extractedDir
  
  3. tarballPath = path.join(tarballCacheDir, `${owner}__${repo}@${sanitizedRef}.tar.gz`)
     If !fs.existsSync(tarballPath):
       - Coalesce concurrent downloads via inflightDownloads Map (same pattern as DTU)
       - Download from https://api.github.com/repos/${owner}/${repo}/tarball/${ref}
         with User-Agent header and redirect following
       - Write to tarballPath + '.tmp.PID', then rename to tarballPath
  
  4. Extract: execSync(`tar -xzf ${tarballPath} -C ${tmpDir}`)
     - The GitHub tarball root is a single dir like 'actions-checkout-abc123'
     - Rename to extractedDir
  
  5. return extractedDir
```

**Concurrency**: `inflightDownloads: Map<string, Promise<string>>` — concurrent requests for same key await the same promise.

**Error handling**: If download or extraction fails, clean up tmp files and re-throw. Never leave partial cache entries.

---

## Action Parser Design (`src/action-parser.ts`)

```
parseActionManifest(actionDir: string): ActionManifest

  1. Look for action.yml, then action.yaml (in that order)
     - Throw if neither found: 'No action.yml found in ${actionDir}'
  
  2. Parse with yaml package (already a dependency)
  
  3. Validate runs.using is one of: 'node20', 'node16', 'node12', 'composite', 'docker'
     - 'docker' actions: log warning "Docker actions not supported" and return manifest
       with a sentinel that action-executor will handle
  
  4. For node actions: validate runs.main is a non-empty string
  
  5. Return typed ActionManifest
```

**Normalization**: All `inputs[*].required` defaults to `false` if absent. All `inputs[*].default` defaults to `''` if absent.

---

## Executor Design (`src/action-executor.ts`)

### Input Resolution

```
resolveInputs(step: Step, manifest: ActionManifest): Record<string, string>

  For each input defined in manifest.inputs:
    value = step.with?.[inputName]        // caller-provided
           ?? manifest.inputs[inputName].default  // manifest default
           ?? undefined
    
    If value === undefined && input.required === true:
      throw new Error(`Required input '${inputName}' not set for action '${step.uses}'`)
    
    If value !== undefined:
      env[`INPUT_${inputName.toUpperCase().replace(/ /g, '_')}`] = value

  // Also pass through any with: keys not in manifest.inputs
  // (some actions read extra inputs not declared in action.yml)
  for each key in step.with:
    if not already in env:
      env[`INPUT_${key.toUpperCase().replace(/ /g, '_')}`] = step.with[key]

  return env  // { 'INPUT_TOKEN': '...', 'INPUT_PATH': '...' }
```

### GITHUB_* Environment Construction

```
buildGithubEnv(context: RunContext, actionDir: string, tempFiles: TempFiles): Record<string, string>

  return {
    ...process.env,                             // host env (documented divergence)
    ...context.fileEnv,                         // accumulated GITHUB_ENV file writes
    
    // Standard GitHub env vars
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_WORKSPACE: context.workspace,
    GITHUB_ACTION_PATH: actionDir,
    
    // File-based command files (created by step-executor)
    GITHUB_OUTPUT: tempFiles.output,
    GITHUB_ENV: tempFiles.env,
    GITHUB_PATH: tempFiles.path,
    GITHUB_STATE: tempFiles.state,
    GITHUB_STEP_SUMMARY: tempFiles.summary,
    
    // GitHub context as env vars (actions/checkout needs GITHUB_TOKEN, etc.)
    GITHUB_REPOSITORY: context.github.repository ?? '',
    GITHUB_SHA: context.github.sha ?? '',
    GITHUB_REF: context.github.ref ?? '',
    GITHUB_REF_NAME: context.github.ref_name ?? '',
    GITHUB_ACTOR: context.github.actor ?? '',
    GITHUB_RUN_ID: context.github.run_id ?? '1',
    GITHUB_RUN_NUMBER: context.github.run_number ?? '1',
    GITHUB_JOB: context.github.job ?? '',
    GITHUB_SERVER_URL: context.github.server_url ?? 'https://github.com',
    GITHUB_API_URL: context.github.api_url ?? 'https://api.github.com',
    GITHUB_EVENT_NAME: context.github.event_name ?? 'push',
    
    // PATH with accumulated additions
    PATH: [...context.pathEntries, process.env.PATH ?? ''].join(':'),
    
    // Secrets
    ...Object.fromEntries(
      Object.entries(context.secrets).map(([k, v]) => [k, v])
    ),
  };
```

### Main Execution Loop

```
executeActionStep(step: Step, context: RunContext, opts: ExecutorOptions): Promise<ActionStepResult>

  // 0. Check for built-in override first (no download needed)
  const override = findBuiltinOverride(step.uses)
  if override: return override.execute(step, context, opts)

  // 1. Resolve action tarball → extractedDir
  const actionDir = await resolveAction(step.uses, opts)

  // 2. Parse action.yml
  const manifest = parseActionManifest(actionDir)

  // 3. Validate type (docker not supported)
  if manifest.runs.using === 'docker':
    log warning, return skipped StepResult

  // 4. Resolve inputs
  const inputEnv = resolveInputs(step, manifest)  // may throw on required

  // 5. Create temp files for command files
  const tempFiles = createTempFiles()  // GITHUB_OUTPUT, GITHUB_ENV, GITHUB_PATH, GITHUB_STATE, GITHUB_STEP_SUMMARY

  // 6. Build full env
  const env = { ...buildGithubEnv(context, actionDir, tempFiles), ...inputEnv, ...step.env }

  // 7. Execute pre script (inline, before main)
  if manifest.runs.pre:
    const preResult = await runNodeScript(
      path.join(actionDir, manifest.runs.pre), env, opts
    )
    if preResult.exitCode !== 0 && !step.continueOnError:
      return failedStepResult(...)

  // 8. Execute main script
  const mainResult = await runNodeScript(
    path.join(actionDir, manifest.runs.main), env, opts
  )

  // 9. Parse command file outputs → StepResult.outputs
  const outputs = parseOutputFile(tempFiles.output)
  const envMutations = parseEnvFile(tempFiles.env)
  const pathMutations = parsePathFile(tempFiles.path)

  // 10. Build postEntry if runs.post defined
  let postEntry: PrePostEntry | undefined
  if manifest.runs.post:
    postEntry = {
      type: 'post',
      actionDir,
      scriptPath: manifest.runs.post,
      inputEnv,
      stepId: step.id ?? '',
      stepName: step.name ?? step.uses ?? '',
    }

  // 11. Cleanup temp files
  cleanupTempFiles(tempFiles)

  return {
    id: step.id ?? autoId,
    name: step.name ?? step.uses ?? '',
    outcome: mainResult.exitCode === 0 ? 'success' : 'failure',
    conclusion: /* apply continue-on-error */ ...,
    outputs,
    env: envMutations,
    path: pathMutations,
    annotations: parseAnnotations(mainResult.stderr),
    postEntry,
  }
```

### `runNodeScript` helper

```
runNodeScript(scriptPath: string, env: Record<string, string>, opts): Promise<ScriptRunResult>

  - spawn: ['node', scriptPath]
  - cwd: env.GITHUB_WORKSPACE
  - env: provided env object
  - stdout: pipe → parse workflow commands (::set-output::, ::error::, etc.) in real-time
  - stderr: pipe → parse ::error:: annotations
  - timeout: opts.timeoutMinutes * 60 * 1000 (SIGTERM → SIGKILL +5s)
  - Returns { exitCode, stdout, stderr }
```

**Note**: Command parsing (the `::` protocol) is a Phase 1 concern (`commands.ts`). Phase 2 references the Phase 1 `parseWorkflowCommands` function. Until Phase 1 is implemented, `runNodeScript` can capture stdout/stderr without parsing commands — outputs will only come from `$GITHUB_OUTPUT` file reads, not `::set-output::`.

---

## Built-in Actions Design (`src/builtin-actions.ts`)

### Detection

Before any tarball download, `executeActionStep` calls `findBuiltinOverride(uses: string)`. The match uses normalized form (strip version):

```typescript
const BUILTIN_MATCHERS: Array<[RegExp, BuiltinHandler]> = [
  [/^actions\/checkout(@|$)/, handleCheckout],
  [/^actions\/setup-node(@|$)/, handleSetupNode],
  [/^actions\/cache(\/|@|$)/, handleCache],
];
```

### `actions/checkout`

Strategy: check if workspace has git content, skip if yes, clone if no.

```
handleCheckout(step, context):
  workDir = context.workspace
  try:
    execSync('git rev-parse HEAD', { cwd: workDir, stdio: 'pipe' })
    // git HEAD is valid → workspace already initialized
    log `[ts-runner] actions/checkout: workspace already has git content, skipping clone`
    return successResult with note in outputs
  catch:
    // workspace is empty or not a git repo
    repoUrl = step.with?.repository
              ?? `${context.github.server_url}/${context.github.repository}`
    ref = step.with?.ref ?? context.github.ref ?? 'main'
    execSync(`git clone ${repoUrl} . && git checkout ${ref}`, { cwd: workDir })
    return successResult
```

### `actions/setup-node`

Strategy: check if requested node version matches current, skip if matches.

```
handleSetupNode(step, context):
  requestedVersion = step.with?.['node-version']
  if not requestedVersion:
    log `[ts-runner] actions/setup-node: no node-version specified, skipping`
    return successResult

  current = execSync('node --version').trim()  // e.g. 'v22.14.0'
  if current satisfies semver range requestedVersion:
    log `[ts-runner] actions/setup-node: node ${current} matches ${requestedVersion}, skipping`
    return successResult
  
  log warning `[ts-runner] actions/setup-node: node ${current} does not match ${requestedVersion}; skipping install in standalone mode`
  return successResult  // still succeed — don't block workflows
```

### `actions/cache`

Always no-op.

```
handleCache(step, context):
  log `[ts-runner] actions/cache: no-op in standalone mode`
  return successResult with outputs['cache-hit'] = 'false'
```

---

## Service Container Lifecycle (`src/service-containers.ts`)

### Container Naming & Labels

```typescript
const CONTAINER_PREFIX = 'ts-runner-svc';

function containerName(runId: string, serviceId: string): string {
  return `${CONTAINER_PREFIX}-${runId}-${serviceId}`;
}

const CONTAINER_LABELS = {
  'ts-runner-svc': 'true',
  'managed-by': 'ts-runner',
};
```

### Startup Sequence

```
startServices(services: ServiceDef[], runId: string, docker: Dockerode): Promise<RunningService[]>

  1. pruneOrphanContainers(docker, runId)     // remove stale ts-runner-svc-* containers

  2. For each service (in order):
    a. Parse port mappings:
         '5432:5432' → ExposedPorts: {'5432/tcp': {}}, PortBindings: {'5432/tcp': [{HostPort: '5432'}]}
       If no port mappings: warn (steps won't be able to reach service)
    
    b. Parse options string → HealthCheckOptions:
         '--health-cmd pg_isready --health-interval 10s --health-timeout 5s --health-retries 5'
         → { cmd: 'pg_isready', intervalMs: 10000, timeoutMs: 5000, retries: 5 }
    
    c. container = await docker.createContainer({
         name: containerName(runId, service.id),
         Image: service.image,
         Env: Object.entries(service.env ?? {}).map(([k,v]) => `${k}=${v}`),
         ExposedPorts: { ... },
         Labels: { ...CONTAINER_LABELS, 'ts-runner-run-id': runId },
         HostConfig: {
           PortBindings: { ... },
           AutoRemove: false,        // we remove explicitly for reliability
         },
         // Add HEALTHCHECK if --health-cmd specified
         Healthcheck: healthCheckOptions.cmd ? {
           Test: ['CMD-SHELL', healthCheckOptions.cmd],
           Interval: (healthCheckOptions.intervalMs ?? 10000) * 1000000,  // nanoseconds
           Timeout: (healthCheckOptions.timeoutMs ?? 5000) * 1000000,
           Retries: healthCheckOptions.retries ?? 3,
         } : undefined,
       })
    
    d. await container.start()
    
    e. actualPorts = await waitForHealthy(container, 60000)

    f. Collect RunningService {
         id: service.id,
         containerId: container.id,
         hostPorts: actualPorts,
         env: service.env ?? {},
       }
  
  3. return RunningService[]
```

### Health Polling

```
waitForHealthy(container: Docker.Container, timeoutMs: number): Promise<Record<number, number>>

  deadline = Date.now() + timeoutMs
  intervalMs = 2000

  while Date.now() < deadline:
    info = await container.inspect()
    
    // Check for container crash
    if info.State.Status === 'exited' or 'dead':
      throw new Error(`Service container exited unexpectedly: ${info.State.ExitCode}`)
    
    // Health check evaluation
    const hasHealthcheck = info.Config.Healthcheck?.Test?.[0] !== 'NONE'
    if hasHealthcheck:
      if info.State.Health?.Status === 'healthy':
        return extractHostPorts(info)
      // 'starting', 'unhealthy' → continue polling
    else:
      // No HEALTHCHECK → wait for 'running' state
      if info.State.Running:
        return extractHostPorts(info)
    
    await sleep(intervalMs)
  
  throw new Error(`Service container did not become healthy within ${timeoutMs}ms`)


extractHostPorts(info: ContainerInspectInfo): Record<number, number>
  // info.NetworkSettings.Ports: {'5432/tcp': [{HostIp: '0.0.0.0', HostPort: '5432'}]}
  result: Record<number, number> = {}
  for each [portProto, bindings] in info.NetworkSettings.Ports:
    containerPort = parseInt(portProto.split('/')[0])
    hostPort = parseInt(bindings[0].HostPort)
    result[containerPort] = hostPort
  return result
```

### Environment Injection

```
buildServiceEnv(services: RunningService[]): Record<string, string>
  // Inject <SERVICEID>_HOST and <SERVICEID>_PORT for primary port, plus per-port vars
  env = {}
  for each service:
    prefix = service.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')
    env[`${prefix}_HOST`] = 'localhost'
    env[`${prefix}_PORT`] = String(first mapped hostPort)
    for [containerPort, hostPort] of service.hostPorts:
      env[`${prefix}_PORT_${containerPort}`] = String(hostPort)
  return env
```

This env is merged into each step's environment by the job runner.

### Teardown

```
stopServices(services: RunningService[], docker: Dockerode): Promise<void>
  // Force-remove all containers; continue even if one fails
  await Promise.allSettled(
    services.map(async (svc) => {
      try:
        const container = docker.getContainer(svc.containerId)
        await container.remove({ force: true })
        log `[ts-runner] Removed service container: ${svc.id} (${svc.containerId.slice(0,12)})`
      catch err:
        log warning `[ts-runner] Failed to remove service container ${svc.id}: ${err.message}`
    })
  )
```

### Orphan Cleanup

```
pruneOrphanContainers(docker: Dockerode, currentRunId: string): Promise<void>
  containers = await docker.listContainers({
    all: true,
    filters: { label: ['ts-runner-svc=true'] }
  })
  
  orphans = containers.filter(c => c.Labels['ts-runner-run-id'] !== currentRunId)
  
  await Promise.allSettled(
    orphans.map(async (c) => {
      const container = docker.getContainer(c.Id)
      await container.remove({ force: true })
      log `[ts-runner] Pruned orphan container: ${c.Names[0]} (${c.Id.slice(0,12)})`
    })
  )
```

---

## Pre/Post Queue Design (`src/pre-post-queue.ts`)

Pre scripts execute inline (before the main step's execution, within `executeActionStep`). Post scripts are collected during job execution and flushed after all steps complete.

```typescript
export class PrePostQueue {
  private postEntries: PrePostEntry[] = [];

  /** Called by executeActionStep when it registers a post script */
  enqueuePost(entry: PrePostEntry): void {
    this.postEntries.push(entry);
  }

  /**
   * Flush all post scripts in LIFO order.
   * Called by the job runner after all steps complete.
   * Errors in post scripts are logged but do not affect the job result.
   */
  async flushPost(
    executeScript: (scriptPath: string, env: Record<string, string>) => Promise<{ exitCode: number }>,
    context: RunContext,
  ): Promise<void> {
    const entries = [...this.postEntries].reverse();
    for (const entry of entries) {
      try {
        const scriptAbs = path.join(entry.actionDir, entry.scriptPath);
        const env = { ...buildGithubEnv(context, entry.actionDir, /* no new temp files needed */ ...) , ...entry.inputEnv };
        const result = await executeScript(scriptAbs, env);
        if (result.exitCode !== 0) {
          console.warn(`[ts-runner] Post script for '${entry.stepName}' exited ${result.exitCode}`);
        }
      } catch (err) {
        console.warn(`[ts-runner] Post script for '${entry.stepName}' threw: ${err}`);
      }
    }
  }
}
```

---

## Integration Point with Phase 1

Phase 1's `job-runner.ts` is the integration site. When complete, it should:

1. **On job start**: 
   ```typescript
   const docker = new Docker();
   const prePostQueue = new PrePostQueue();
   const runningServices = await startServices(job.services ?? {}, runId, docker);
   const serviceEnv = buildServiceEnv(runningServices);
   ```

2. **For each step**:
   ```typescript
   if (step.uses) {
     const result = await executeActionStep(step, context, { prePostQueue, serviceEnv, ... });
     if (result.postEntry) prePostQueue.enqueuePost(result.postEntry);
   } else {
     // Phase 1 script execution
   }
   ```

3. **After all steps**:
   ```typescript
   await prePostQueue.flushPost(runNodeScript, context);
   await stopServices(runningServices, docker);
   ```

---

## What Can Go Wrong

### 1. Tarball extraction race condition
**Risk**: Two parallel job runs extract the same action tarball concurrently → partial extracted dir.  
**Mitigation**: Extract to a temp dir first, then atomically rename to `extractedDir`. Check if `extractedDir` exists before extracting. `inflightDownloads` coalesces downloads but not extractions. Add extraction-in-progress sentinel file (`.extracting`) to detect crashes.

### 2. Docker daemon not running
**Risk**: `startServices` throws on first dockerode call; unhandled error kills the process.  
**Mitigation**: Wrap `new Docker()` call in a try/catch with a clear error message. If no `services:` block exists, Docker is never instantiated.

### 3. Port already in use
**Risk**: `createContainer` succeeds but another process owns the host port → container fails to bind.  
**Mitigation**: `waitForHealthy` detects container exit status and throws. Surface the container exit code in the error message.

### 4. Post-script failure masking job result
**Risk**: A post-script failure overwrites a successful job outcome.  
**Mitigation**: Post-script errors are logged as warnings, never promoted to job failures. `flushPost` catches all errors.

### 5. Orphan container interference
**Risk**: Orphan cleanup removes containers from a *concurrent* run (if two ts-runner instances share the same Docker daemon).  
**Mitigation**: Run ID is a `crypto.randomUUID()` — unique per run. Only containers with a different `ts-runner-run-id` label are pruned.

### 6. `actions/checkout` workspace check false positive
**Risk**: `git rev-parse HEAD` succeeds in a non-git parent directory if run from a git repo path, causing checkout to be skipped even when the workflow workspace is uninitialized.  
**Mitigation**: Run the check with `{ cwd: context.workspace }` — the workspace path is exact.

### 7. Built-in override version mismatch
**Risk**: A workflow uses `actions/checkout@v3` while the built-in override is designed for `@v4` behavior, causing subtle behavioral differences.  
**Mitigation**: The override applies to all versions of the action. The override behavior (check for git content, then clone) is version-agnostic. Document this divergence in SPEC.md.

### 8. `INPUT_*` env var name collisions
**Risk**: An action input named `token` collides with `INPUT_TOKEN` from another source.  
**Mitigation**: `buildGithubEnv` constructs env first, then `inputEnv` is spread over it — inputs always win, which is the correct precedence (caller's `with:` values are most specific).

### 9. `node` binary version mismatch
**Risk**: Action targets `node20` but system has `node22` — potential subtle behavior differences.  
**Mitigation**: ts-runner runs actions with the system `node` binary regardless of `runs.using` version specifier. This is a documented divergence from GitHub Actions (which downloads the specific Node version). Document in SPEC.md.

---

## Task Breakdown

### T0 — Define types (prerequisite for all other tasks)
- [ ] Create `src/types.ts` with all types from this RFC
- [ ] Commit: "Define Phase 1 + Phase 2 TypeScript contracts in types.ts"

### T1 — Tarball cache helpers
- [ ] Create `src/action-resolver.ts`
- [ ] Implement `getTarballCacheDir()` (env var resolution)
- [ ] Implement `actionTarballPath(owner, repo, ref): string` (matching DTU naming)
- [ ] Implement `resolveAction(actionRef, opts): Promise<string>` with in-flight coalescing
- [ ] Implement `fetchWithRedirects` (copy pattern from DTU's implementation)
- [ ] Commit: "Implement action tarball resolver with shared DTU cache"

### T2 — Action YAML parser
- [ ] Create `src/action-parser.ts`
- [ ] Implement `parseActionManifest(actionDir: string): ActionManifest`
- [ ] Handle `action.yml` vs `action.yaml` fallback
- [ ] Validate `runs.using` enum
- [ ] Normalize input defaults
- [ ] Commit: "Implement action.yml parser producing typed ActionManifest"

### T3 — Built-in action overrides
- [ ] Create `src/builtin-actions.ts`
- [ ] Implement `findBuiltinOverride(uses: string): BuiltinHandler | undefined`
- [ ] Implement `handleCheckout`: git-based workspace check + clone fallback
- [ ] Implement `handleSetupNode`: semver match check + warning
- [ ] Implement `handleCache`: no-op returning `cache-hit=false`
- [ ] Commit: "Implement built-in override handlers for checkout, setup-node, cache"

### T4 — Temp file management
- [ ] In `src/action-executor.ts`, implement `createTempFiles(): TempFiles`
- [ ] Implement `parseOutputFile(path: string): Record<string, string>` (GITHUB_OUTPUT format)
- [ ] Implement `parseEnvFile(path: string): Record<string, string>` (GITHUB_ENV format)
- [ ] Implement `parsePathFile(path: string): string[]` (GITHUB_PATH format)
- [ ] Commit: "Implement temp file creation and command file parsers"

### T5 — Pre/post queue
- [ ] Create `src/pre-post-queue.ts`
- [ ] Implement `PrePostQueue` class with `enqueuePost()` and `flushPost()`
- [ ] Commit: "Implement pre/post script queue"

### T6 — JS action executor
- [ ] Complete `src/action-executor.ts`
- [ ] Implement `resolveInputs(step, manifest): Record<string, string>`
- [ ] Implement `buildGithubEnv(context, actionDir, tempFiles): Record<string, string>`
- [ ] Implement `runNodeScript(scriptPath, env, opts): Promise<ScriptRunResult>` with spawn + timeout
- [ ] Implement `executeActionStep(step, context, opts): Promise<ActionStepResult>`
- [ ] Wire: override check → resolve → parse → validate inputs → pre → main → collect outputs → queue post
- [ ] Commit: "Implement JS action executor with input resolution and pre/post wiring"

### T7 — Service containers
- [ ] Create `src/service-containers.ts`
- [ ] Implement `parsePortMappings(ports: string[]): { ExposedPorts, PortBindings }`
- [ ] Implement `parseOptions(options: string): HealthCheckOptions`
- [ ] Implement `startServices(services, runId, docker): Promise<RunningService[]>`
- [ ] Implement `waitForHealthy(container, timeoutMs): Promise<Record<number, number>>`
- [ ] Implement `extractHostPorts(info): Record<number, number>`
- [ ] Implement `buildServiceEnv(services: RunningService[]): Record<string, string>`
- [ ] Implement `stopServices(services, docker): Promise<void>`
- [ ] Implement `pruneOrphanContainers(docker, runId): Promise<void>`
- [ ] Commit: "Implement Docker service container lifecycle management"

### T8 — Public API and index exports
- [ ] Update `src/index.ts` to export Phase 2 public API
- [ ] Export: `executeActionStep`, `ServiceContainerManager` (class wrapping start/stop/env), `PrePostQueue`
- [ ] Commit: "Export Phase 2 public API from index.ts"

### T9 — Package dependency update
- [ ] Add `dockerode@^4.0.2` and `@types/dockerode@^3.3.34` to `package.json`
- [ ] Run `pnpm install` to update lockfile
- [ ] Commit: "Add dockerode dependency to ts-runner"

### T10 — SPEC.md update
- [ ] Update SPEC.md `uses:` row from "Detected / skipped" to "Yes (node20/node16/node12)"
- [ ] Update `$GITHUB_STATE` row from "Ignored" to "Yes (for pre/post scripts)"
- [ ] Update `services:` row from "Planned" to "Yes"
- [ ] Add "Node binary version divergence" to Known Divergences
- [ ] Commit: "Update SPEC.md to reflect Phase 2 capabilities"

---

## Relevant Learnings & Decisions

### DTU tarball cache sharing
The DTU (`packages/dtu-github-actions/src/server/routes/actions/index.ts:25-29`) uses a specific naming scheme for tarballs: `${owner}__${repo}@${sanitizedRef}.tar.gz` where `sanitizedRef = ref.replace(/[^a-zA-Z0-9._-]/g, '-')`. ts-runner must use the exact same scheme to read from the shared cache without re-downloading.

### Dockerode version
`pnpm-lock.yaml` locks `dockerode@4.0.9`. `packages/cli/package.json` specifies `^4.0.2`. Adding the same range to ts-runner will resolve to the same version — no new download needed.

### ESM constraint
All files must use `import`, not `require`. Dockerode is a CommonJS module, but `import Dockerode from 'dockerode'` works under NodeNext module resolution with `esModuleInterop: true` (already in `tsconfig.json`).

### tar extraction
The DTU uses `execSync('tar -xzf ...')` for extraction. Same approach in ts-runner avoids adding a tar-parsing npm dependency.

### `GITHUB_*` env vars for JS actions
SPEC.md `src/SPEC.md:163-180` notes that most `GITHUB_*` env vars are NOT set by ts-runner (only the file-based command vars). However, JS actions commonly read `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_SHA`, etc. directly from `process.env`. For Phase 2, `buildGithubEnv` explicitly populates these — this is a controlled expansion of what SPEC.md currently documents.

### `actions/checkout` strategy
The most common use of `actions/checkout` in an agent-ci context is to check out the current repo before running steps. Since agent-ci runs in the repo directory by default, the workspace already has the git content. The skip-if-git-exists strategy covers ~100% of agent-ci use cases. Full clone fallback covers edge cases.

### Phase 1 absence — implementation ordering
Phase 1 types are defined in `src/types.ts` as part of Phase 2. The Phase 2 modules (`action-executor.ts`, `service-containers.ts`) depend on these types but are otherwise self-contained. Integration with Phase 1's job runner is deferred to when Phase 1 is implemented. This means Phase 2 can be type-checked and unit-tested without Phase 1 existing.
