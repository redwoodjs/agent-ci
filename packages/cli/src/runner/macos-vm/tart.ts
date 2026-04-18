import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

// ─── Pure argv builders (unit-testable) ───────────────────────────────────────
//
// These return plain string[] so tests can assert the exact commands we will
// run without actually spawning anything. All side-effecting functions below
// build argv via these helpers.

export function tartPullArgs(image: string): [string, string[]] {
  return ["tart", ["pull", image]];
}

export function tartCloneArgs(base: string, name: string): [string, string[]] {
  return ["tart", ["clone", base, name]];
}

export function tartRunArgs(name: string, opts: { graphics?: boolean } = {}): [string, string[]] {
  const args = ["run"];
  if (opts.graphics !== true) {
    args.push("--no-graphics");
  }
  args.push(name);
  return ["tart", args];
}

export function tartIpArgs(name: string): [string, string[]] {
  return ["tart", ["ip", name]];
}

export function tartStopArgs(name: string): [string, string[]] {
  return ["tart", ["stop", name]];
}

export function tartDeleteArgs(name: string): [string, string[]] {
  return ["tart", ["delete", name]];
}

export function tartListArgs(): [string, string[]] {
  return ["tart", ["list", "--format", "json"]];
}

export interface SshCreds {
  user: string;
  password: string;
}

// Build the argv we pass to sshpass+ssh. We disable host key checking because
// cloned VMs rotate their host keys on every clone — verifying would fail every
// run. BatchMode=no is explicit so sshpass can still feed the password.
export function sshArgs(ip: string, creds: SshCreds, remoteCmd: string[] = []): [string, string[]] {
  const base = [
    "-p",
    creds.password,
    "ssh",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "LogLevel=ERROR",
    "-o",
    "ConnectTimeout=5",
    `${creds.user}@${ip}`,
    ...remoteCmd,
  ];
  return ["sshpass", base];
}

// Build the argv for rsync over sshpass+ssh. Direction is controlled by the
// order of src and dst — we just wire the transport.
export function rsyncArgs(
  src: string,
  dst: string,
  creds: SshCreds,
  opts: { exclude?: string[]; delete?: boolean } = {},
): [string, string[]] {
  const rsyncRsh = [
    "sshpass",
    "-p",
    creds.password,
    "ssh",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "LogLevel=ERROR",
  ].join(" ");
  const args = ["-az", "-e", rsyncRsh];
  if (opts.delete) {
    args.push("--delete");
  }
  for (const pattern of opts.exclude ?? []) {
    args.push("--exclude", pattern);
  }
  args.push(src, dst);
  return ["rsync", args];
}

// ─── I/O wrappers ─────────────────────────────────────────────────────────────
//
// Thin helpers that actually run the commands. Callers normally use these; the
// argv builders above are exported so higher-level job orchestration can
// preview the exact shell invocation in debug logs if needed.

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

// ─── High-level tart lifecycle ────────────────────────────────────────────────

export async function listImages(): Promise<string[]> {
  const [cmd, args] = tartListArgs();
  const r = await runCommand(cmd, args);
  if (r.code !== 0) {
    return [];
  }
  try {
    const rows = JSON.parse(r.stdout) as Array<{ Name?: string; name?: string }>;
    return rows.map((row) => row.Name ?? row.name ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

export async function pullImage(image: string): Promise<void> {
  const [cmd, args] = tartPullArgs(image);
  expectSuccess(`tart pull ${image}`, await runCommand(cmd, args));
}

export async function clone(base: string, name: string): Promise<void> {
  const [cmd, args] = tartCloneArgs(base, name);
  expectSuccess(`tart clone ${base} → ${name}`, await runCommand(cmd, args));
}

// Start the VM in the background. Returns the ChildProcess so callers can
// kill it during cleanup; `tart stop` will also terminate it, but holding the
// handle lets us react quickly if the VM exits unexpectedly during boot.
export function runBackground(
  name: string,
  opts: { graphics?: boolean; env?: NodeJS.ProcessEnv } = {},
): ChildProcess {
  const [cmd, args] = tartRunArgs(name, { graphics: opts.graphics });
  return spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: opts.env ?? process.env,
    detached: false,
  });
}

export async function getIp(name: string): Promise<string | null> {
  const [cmd, args] = tartIpArgs(name);
  const r = await runCommand(cmd, args, { timeoutMs: 5000 });
  if (r.code !== 0) {
    return null;
  }
  const ip = r.stdout.trim();
  return ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
}

export async function stop(name: string): Promise<void> {
  const [cmd, args] = tartStopArgs(name);
  await runCommand(cmd, args, { timeoutMs: 30_000 });
}

export async function destroy(name: string): Promise<void> {
  const [cmd, args] = tartDeleteArgs(name);
  await runCommand(cmd, args, { timeoutMs: 10_000 });
}

// ─── Waiters ──────────────────────────────────────────────────────────────────

export async function waitForIp(name: string, timeoutMs = 90_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ip = await getIp(name);
    if (ip) {
      return ip;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for VM ${name} to get an IP`);
}

export async function waitForSsh(ip: string, creds: SshCreds, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [cmd, args] = sshArgs(ip, creds, ["true"]);
    const r = await runCommand(cmd, args, { timeoutMs: 8000 }).catch(() => null);
    if (r && r.code === 0) {
      return;
    }
    await sleep(1500);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for SSH on ${ip}`);
}

// ─── SSH exec ─────────────────────────────────────────────────────────────────

// Run a remote shell script via `ssh bash -s` with the script piped to stdin.
// This is the quoting-safe pattern — ssh joins argv with spaces remote-side,
// so `ssh bash -c 'foo -v'` drops the -v. Heredoc via stdin avoids the trap.
export async function sshExecScript(
  ip: string,
  creds: SshCreds,
  script: string,
  opts: { timeoutMs?: number; onStdout?: (c: string) => void; onStderr?: (c: string) => void } = {},
): Promise<RunResult> {
  const [cmd, args] = sshArgs(ip, creds, ["bash", "-s"]);
  return runCommand(cmd, args, {
    input: script,
    timeoutMs: opts.timeoutMs,
    onStdout: opts.onStdout,
    onStderr: opts.onStderr,
  });
}

// ─── DNS override ─────────────────────────────────────────────────────────────
//
// tart's built-in NAT DNS proxy (at the bridge gateway) is unreliable on some
// host networks — TCP/ICMP work but UDP DNS silently drops. We worked around
// this in the Phase 1 spike by pointing the VM's DNS at a public resolver
// after SSH was ready. This replays that fix inside the new module.
// Reference: experiments/tart-pindrop.sh

export async function applyDnsOverride(
  ip: string,
  creds: SshCreds,
  dns: string[] = ["1.1.1.1", "8.8.8.8"],
): Promise<void> {
  const script = `set -euo pipefail
echo "${creds.password}" | sudo -S networksetup -setdnsservers Ethernet ${dns.join(" ")}
# Verify the override worked before returning. If this fails the job would
# blow up with opaque "Could not resolve host" errors much later.
dig +short +time=5 +tries=1 github.com >/dev/null
`;
  const r = await sshExecScript(ip, creds, script, { timeoutMs: 20_000 });
  if (r.code !== 0) {
    throw new Error(
      `DNS override failed on ${ip}: ${(r.stderr || r.stdout).trim() || "exit " + r.code}`,
    );
  }
}

// ─── Rsync ────────────────────────────────────────────────────────────────────

export async function rsyncTo(
  ip: string,
  creds: SshCreds,
  localSrc: string,
  remoteDst: string,
  opts: { exclude?: string[]; delete?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  // Normalize: rsync treats `src/` and `src` differently. We always want the
  // directory contents to land at the remote path, so append a trailing slash.
  const src = localSrc.endsWith("/") ? localSrc : localSrc + "/";
  const dst = `${creds.user}@${ip}:${remoteDst}`;
  const [cmd, args] = rsyncArgs(src, dst, creds, {
    exclude: opts.exclude,
    delete: opts.delete,
  });
  expectSuccess(
    `rsync ${src} → ${dst}`,
    await runCommand(cmd, args, { timeoutMs: opts.timeoutMs ?? 600_000 }),
  );
}

export async function rsyncFrom(
  ip: string,
  creds: SshCreds,
  remoteSrc: string,
  localDst: string,
  opts: { exclude?: string[]; timeoutMs?: number } = {},
): Promise<void> {
  const src = `${creds.user}@${ip}:${remoteSrc}`;
  const [cmd, args] = rsyncArgs(src, localDst, creds, { exclude: opts.exclude });
  expectSuccess(
    `rsync ${src} → ${localDst}`,
    await runCommand(cmd, args, { timeoutMs: opts.timeoutMs ?? 600_000 }),
  );
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
