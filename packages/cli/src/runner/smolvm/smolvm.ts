import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

// ─── Pure argv builders (unit-testable) ───────────────────────────────────────
//
// smolvm splits ephemeral and persistent VMs across two top-level subcommands:
//   - `machine run`    — ephemeral; no `--name`. Pass image + command, VM is
//                        torn down when the command exits (unless --detach).
//   - `machine create` — persistent named config; no boot.
//   - `machine start`  — boot a previously-created named VM.
// We need persistent VMs so we can exec into them across the job lifecycle,
// so the high-level `runMachine` below composes create + start.
//
// CLI surface verified against smolvm 0.5.20. See:
//   https://github.com/smol-machines/smolvm

export interface CreateMachineOptions {
  /** Container image (e.g. "ubuntu:22.04"). Optional for bare-VM mode. */
  image?: string;
  /**
   * Path to a packed .smolmachine artifact. Mutually exclusive with `image` —
   * --from skips the OCI registry pull entirely, reusing pre-extracted layers
   * from a prior `smolvm pack create`. Use this to amortize the pull across
   * many VMs (one pack, N creates).
   */
  fromPack?: string;
  /** virtiofs bind mounts: HOST:GUEST or HOST:GUEST:ro. */
  volumes?: string[];
  /** vCPU count. Defaults to smolvm's own default (4) when omitted. */
  cpus?: number;
  /** Memory in MiB. smolvm expects a number, not "8G"-style strings. */
  memMib?: number;
  /** Storage disk size in GiB (for OCI layers + container data). */
  storageGib?: number;
  /** Enable network egress. smolvm requires explicit opt-in. */
  network?: boolean;
  allowCidr?: string[];
  allowHost?: string[];
  /** Per-VM env vars (set on create, persist across exec sessions). */
  env?: Record<string, string>;
  /** Working directory inside the guest. */
  workdir?: string;
}

export function createMachineArgs(
  name: string,
  opts: CreateMachineOptions = {},
): [string, string[]] {
  const args: string[] = ["machine", "create"];
  if (opts.fromPack !== undefined && opts.image !== undefined) {
    throw new Error("createMachineArgs: pass either `image` or `fromPack`, not both");
  }
  if (opts.fromPack !== undefined) {
    args.push("--from", opts.fromPack);
  } else if (opts.image !== undefined) {
    args.push("-I", opts.image);
  }
  if (opts.cpus !== undefined) {
    args.push("--cpus", String(opts.cpus));
  }
  if (opts.memMib !== undefined) {
    args.push("--mem", String(opts.memMib));
  }
  if (opts.storageGib !== undefined) {
    args.push("--storage", String(opts.storageGib));
  }
  if (opts.network) {
    args.push("--net");
  }
  for (const cidr of opts.allowCidr ?? []) {
    args.push("--allow-cidr", cidr);
  }
  for (const host of opts.allowHost ?? []) {
    args.push("--allow-host", host);
  }
  for (const v of opts.volumes ?? []) {
    args.push("-v", v);
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push("-e", `${k}=${v}`);
  }
  if (opts.workdir) {
    args.push("-w", opts.workdir);
  }
  args.push(name);
  return ["smolvm", args];
}

export function startArgs(name: string): [string, string[]] {
  return ["smolvm", ["machine", "start", "--name", name]];
}

export interface RunEphemeralOptions extends CreateMachineOptions {
  /** Detach (background) the VM and keep it alive after the command exits. */
  detach?: boolean;
  interactive?: boolean;
  tty?: boolean;
  timeout?: string;
}

// `machine run` for ephemeral, fire-and-forget VMs. No --name. Useful for
// smoke tests / one-shots; the persistent path uses create + start.
export function runEphemeralArgs(
  image: string,
  command: string[] = [],
  opts: RunEphemeralOptions = {},
): [string, string[]] {
  const args: string[] = ["machine", "run"];
  if (opts.detach) {
    args.push("-d");
  }
  if (opts.interactive) {
    args.push("-i");
  }
  if (opts.tty) {
    args.push("-t");
  }
  if (opts.timeout) {
    args.push("--timeout", opts.timeout);
  }
  if (opts.cpus !== undefined) {
    args.push("--cpus", String(opts.cpus));
  }
  if (opts.memMib !== undefined) {
    args.push("--mem", String(opts.memMib));
  }
  if (opts.network) {
    args.push("--net");
  }
  for (const cidr of opts.allowCidr ?? []) {
    args.push("--allow-cidr", cidr);
  }
  for (const host of opts.allowHost ?? []) {
    args.push("--allow-host", host);
  }
  for (const v of opts.volumes ?? []) {
    args.push("-v", v);
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push("-e", `${k}=${v}`);
  }
  if (opts.workdir) {
    args.push("-w", opts.workdir);
  }
  args.push("-I", image);
  if (command.length > 0) {
    args.push("--", ...command);
  }
  return ["smolvm", args];
}

export interface ExecOptions {
  tty?: boolean;
  interactive?: boolean;
  env?: Record<string, string>;
  workdir?: string;
}

export function execArgs(name: string, cmd: string[], opts: ExecOptions = {}): [string, string[]] {
  const args: string[] = ["machine", "exec", "--name", name];
  if (opts.interactive) {
    args.push("-i");
  }
  if (opts.tty) {
    args.push("-t");
  }
  if (opts.workdir) {
    args.push("-w", opts.workdir);
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push("-e", `${k}=${v}`);
  }
  args.push("--", ...cmd);
  return ["smolvm", args];
}

export function stopArgs(name: string): [string, string[]] {
  return ["smolvm", ["machine", "stop", "--name", name]];
}

// `machine delete` takes the name positionally. -f skips the confirmation
// prompt; without it the command would block on stdin in our non-interactive
// teardown path.
export function deleteArgs(name: string): [string, string[]] {
  return ["smolvm", ["machine", "delete", "-f", name]];
}

export function listArgs(): [string, string[]] {
  return ["smolvm", ["machine", "ls", "--json"]];
}

export function statusArgs(name: string): [string, string[]] {
  return ["smolvm", ["machine", "status", "--name", name]];
}

// `smolvm pack create -I <image> -o <output>` bundles an OCI image into a
// self-contained .smolmachine file we can later instantiate with
// `machine create --from <path>` — skipping the per-VM registry pull.
export function packCreateArgs(image: string, outputPath: string): [string, string[]] {
  return ["smolvm", ["pack", "create", "-I", image, "-o", outputPath]];
}

// ─── I/O wrappers ─────────────────────────────────────────────────────────────

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  input?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export function runCommand(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = {
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env ?? process.env,
      cwd: opts.cwd,
    };
    const child = spawn(cmd, args, spawnOpts);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 2000).unref();
        }, opts.timeoutMs)
      : null;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      opts.onStdout?.(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      opts.onStderr?.(chunk);
    });

    child.on("error", (err) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (timedOut) {
        return reject(new Error(`${cmd} ${args.join(" ")} timed out after ${opts.timeoutMs}ms`));
      }
      resolve({ code: code ?? -1, stdout, stderr });
    });

    if (opts.input !== undefined) {
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
  });
}

function expectSuccess(label: string, result: RunResult): RunResult {
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`${label} failed (exit ${result.code}): ${detail}`);
  }
  return result;
}

// ─── High-level smolvm lifecycle ──────────────────────────────────────────────

// Create a named VM and start it. We need the named/persistent path because
// the job orchestration execs into the VM multiple times across boot.
// Pass `image` to pull from a registry, or `fromPack` to instantiate from a
// pre-built .smolmachine artifact (faster + dodges per-VM network pulls).
export async function createAndStart(
  name: string,
  source: { image: string } | { fromPack: string },
  opts: Omit<CreateMachineOptions, "image" | "fromPack"> = {},
): Promise<void> {
  const [cCmd, cArgs] = createMachineArgs(name, { ...opts, ...source });
  expectSuccess(`smolvm machine create ${name}`, await runCommand(cCmd, cArgs));
  const [sCmd, sArgs] = startArgs(name);
  expectSuccess(`smolvm machine start ${name}`, await runCommand(sCmd, sArgs));
}

// Pack an OCI image into a .smolmachine if not already cached. `basePath` is
// the prefix (without extension); smolvm produces TWO files:
//   - <basePath>             — self-contained launcher executable (~30MB)
//   - <basePath>.smolmachine — the artifact `machine create --from` wants
// We always return the .smolmachine sidecar path and treat its presence as
// the cache hit. Idempotent. Caller is responsible for cache eviction.
export async function packImageIfMissing(image: string, basePath: string): Promise<string> {
  const fs = await import("node:fs");
  const sidecar = `${basePath}.smolmachine`;
  if (fs.existsSync(sidecar)) {
    return sidecar;
  }
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  await fsp.mkdir(path.dirname(basePath), { recursive: true });
  const [cmd, args] = packCreateArgs(image, basePath);
  expectSuccess(`smolvm pack create ${image}`, await runCommand(cmd, args, { timeoutMs: 600_000 }));
  return sidecar;
}

export async function exec(
  name: string,
  cmd: string[],
  opts: ExecOptions & { timeoutMs?: number; input?: string } = {},
): Promise<RunResult> {
  const [bin, args] = execArgs(name, cmd, opts);
  return runCommand(bin, args, { input: opts.input, timeoutMs: opts.timeoutMs });
}

// Run a shell script via `exec -i -- bash -s` with the script piped to stdin.
// Same quoting-safe pattern as the tart adapter — heredoc-via-stdin avoids
// argv-joining traps.
export async function execScript(
  name: string,
  script: string,
  opts: { timeoutMs?: number; onStdout?: (c: string) => void; onStderr?: (c: string) => void } = {},
): Promise<RunResult> {
  const [bin, args] = execArgs(name, ["bash", "-s"], { interactive: true });
  return runCommand(bin, args, {
    input: script,
    timeoutMs: opts.timeoutMs,
    onStdout: opts.onStdout,
    onStderr: opts.onStderr,
  });
}

export async function stop(name: string): Promise<void> {
  const [cmd, args] = stopArgs(name);
  await runCommand(cmd, args, { timeoutMs: 30_000 });
}

export async function destroy(name: string): Promise<void> {
  const [cmd, args] = deleteArgs(name);
  await runCommand(cmd, args, { timeoutMs: 10_000 });
}

export async function listMachines(): Promise<string[]> {
  const [cmd, args] = listArgs();
  const r = await runCommand(cmd, args);
  if (r.code !== 0) {
    return [];
  }
  try {
    const rows = JSON.parse(r.stdout) as Array<{ name?: string; Name?: string }>;
    return rows.map((row) => row.name ?? row.Name ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

// Spawn an attached `machine run` (ephemeral). Useful for smoke tests where
// the caller wants to stream output of a one-shot command.
export function runEphemeralAttached(
  image: string,
  command: string[] = [],
  opts: RunEphemeralOptions = {},
): ChildProcess {
  const [cmd, args] = runEphemeralArgs(image, command, opts);
  return spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    detached: false,
  });
}
