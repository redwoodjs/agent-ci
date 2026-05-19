import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MACHINEN = join(
  ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "machinen.cmd" : "machinen",
);
const MACHINEN_DIR = join(ROOT, ".machinen");
const IMAGE = join(MACHINEN_DIR, "rootfs.tar.gz");
const SNAPSHOT_ROOT = join(MACHINEN_DIR, "snapshots");

const GUEST_WORKSPACE = "/mnt/workspace";
const GUEST_PI_AGENT = "/mnt/pi-agent";
const GUEST_PNPM_STORE = "/mnt/pnpm-store";
const GUEST_GIT_COMMON = "/mnt/git";
const GUEST_NODE_MODULES = `${GUEST_WORKSPACE}/node_modules`;

const COMMANDS = ["attach", "shell", "snapshot", "stop"] as const;
type Command = (typeof COMMANDS)[number];
type Worktree = {
  branch: string;
  path: string;
  gitCommonDir: string;
  guestGitDir: string;
};
type VmEntry = {
  name: string | null;
  ports?: Array<{ hostPort: number; guestPort: number }>;
};

const PORTABLE_PI_SETTINGS = [
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
  "quietStartup",
  "telemetry",
];

function usage(): never {
  console.error(`Usage:
  pnpm vm             Boot or attach to PI in a machinen VM for this worktree
  pnpm vm shell       Boot or attach to an interactive shell in the VM
  pnpm vm snapshot    Snapshot this worktree's running VM into .machinen/snapshots/
  pnpm vm stop        Stop this worktree's running VM

Run this from a linked git worktree, not the main checkout. For example:
  git worktree add ../agent-ci-my-branch -b my-branch
  cd ../agent-ci-my-branch
  pnpm install
  pnpm vm

Environment:
  MACHINEN_VM_NO_ATTACH=1             Boot/configure without attaching
  MACHINEN_VM_PORTS=5173:5173,3000    Forward host:guest ports while booting
  MACHINEN_VM_SKIP_INSTALL=1          Skip pnpm install inside the VM
`);
  process.exit(1);
}

function command(): Command {
  const [raw = "attach", extra] = process.argv.slice(2);
  if (raw === "-h" || raw === "--help" || extra) {
    usage();
  }
  if (!COMMANDS.includes(raw as Command)) {
    console.error(`Unknown command: ${raw}`);
    usage();
  }
  return raw as Command;
}

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

function statusCode(result: { status: number | null }): number {
  return result.status ?? 1;
}

function run(command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function output(command: string, args: string[]): string {
  const result = run(command, args);
  if ((result.status ?? 1) !== 0) {
    fail(
      result.stderr?.trim() || result.error?.message || `${command} ${args.join(" ")} failed`,
      statusCode(result),
    );
  }
  return result.stdout.trim();
}

function git(args: string[]): string {
  return output("git", ["-C", ROOT, ...args]);
}

function machinenOutput(args: string[], inheritStderr = false): string {
  const result = run(MACHINEN, args, inheritStderr ? { stdio: ["ignore", "pipe", "inherit"] } : {});
  if ((result.status ?? 1) !== 0) {
    fail(
      result.stderr?.trim() || result.error?.message || `machinen ${args.join(" ")} failed`,
      statusCode(result),
    );
  }
  return result.stdout.trim();
}

function machinen(args: string[]): void {
  const result = spawnSync(MACHINEN, args, { stdio: "inherit" });
  if ((result.status ?? 1) !== 0) {
    process.exit(statusCode(result));
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function envPair(key: string, value: string): string {
  return `${key}=${shellQuote(value)}`;
}

function guestGitExports(worktree: Worktree): string {
  return [
    `export ${envPair("GIT_DIR", worktree.guestGitDir)}`,
    `export ${envPair("GIT_COMMON_DIR", GUEST_GIT_COMMON)}`,
    `export ${envPair("GIT_WORK_TREE", GUEST_WORKSPACE)}`,
  ].join("\n");
}

function piCommand(worktree: Worktree): string {
  return `cd ${GUEST_WORKSPACE} && env HOME=/root SHELL=/bin/bash TERM=xterm-256color PI_CODING_AGENT_DIR=/root/.pi/agent ${envPair("GIT_DIR", worktree.guestGitDir)} ${envPair("GIT_COMMON_DIR", GUEST_GIT_COMMON)} ${envPair("GIT_WORK_TREE", GUEST_WORKSPACE)} pi`;
}

function vmList(): VmEntry[] {
  return JSON.parse(machinenOutput(["list", "--json"])).vms ?? [];
}

function runningVm(name: string): VmEntry | undefined {
  return vmList().find((vm) => vm.name === name);
}

function vmSh(name: string, script: string): void {
  machinen(["exec", name, "--", "bash", "-lc", shellQuote(script)]);
}

function currentWorktree(): Worktree {
  const gitDir = resolve(ROOT, git(["rev-parse", "--absolute-git-dir"]));
  const commonDir = resolve(ROOT, git(["rev-parse", "--git-common-dir"]));

  if (gitDir === commonDir) {
    fail(`pnpm vm must be run from a linked git worktree, not the main checkout.

Create one first, then run pnpm vm there. For example:
  git worktree add ../agent-ci-my-branch -b my-branch
  cd ../agent-ci-my-branch
  pnpm install
  pnpm vm`);
  }

  const branch = git(["branch", "--show-current"]);
  if (!branch) {
    fail("pnpm vm needs a named branch. Detached HEAD worktrees are not supported.");
  }

  const gitDirFromCommon = relative(commonDir, gitDir);
  if (gitDirFromCommon.startsWith("..")) {
    fail(`Could not map worktree git dir ${gitDir} under ${commonDir}.`);
  }

  return {
    branch,
    path: ROOT,
    gitCommonDir: commonDir,
    guestGitDir: join(GUEST_GIT_COMMON, gitDirFromCommon),
  };
}

function hostGitHubToken(): string {
  const envToken =
    process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.AGENT_CI_GITHUB_TOKEN;
  if (envToken?.trim()) {
    return envToken.trim();
  }

  const result = run("gh", ["auth", "token"]);
  if ((result.status ?? 1) !== 0 || !result.stdout.trim()) {
    fail(
      result.stderr?.trim() ||
        result.error?.message ||
        "Could not read a GitHub token. Run `gh auth login` on the host first.",
      statusCode(result),
    );
  }
  return result.stdout.trim();
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function copyIfExists(source: string, dest: string): void {
  if (existsSync(source)) {
    copyFileSync(source, dest);
  }
}

function copyDirIfExists(source: string, dest: string): void {
  if (existsSync(source)) {
    rmSync(dest, { recursive: true, force: true });
    cpSync(source, dest, { recursive: true, dereference: true });
  }
}

function ensurePiAgent(vmStateDir: string): string {
  const source = resolve(process.env.PI_AGENT_SOURCE?.trim() || join(homedir(), ".pi", "agent"));
  const dest = join(vmStateDir, "pi-agent");
  const auth = join(source, "auth.json");
  if (!existsSync(auth)) {
    fail(`${auth} not found. Run \`pi\` and /login on the host, then rerun \`pnpm vm\`.`);
  }

  for (const dir of [
    dest,
    join(dest, "sessions"),
    join(dest, "skills"),
    join(dest, "extensions"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  chmodSync(dest, 0o700);
  chmodSync(join(dest, "sessions"), 0o700);

  copyFileSync(auth, join(dest, "auth.json"));
  chmodSync(join(dest, "auth.json"), 0o600);

  const sourceSettings = readJson(join(source, "settings.json"));
  const portableSettings = Object.fromEntries(
    PORTABLE_PI_SETTINGS.flatMap((key) =>
      sourceSettings[key] === undefined ? [] : [[key, sourceSettings[key]]],
    ),
  );
  writeFileSync(join(dest, "settings.json"), `${JSON.stringify(portableSettings, null, 2)}\n`);
  copyIfExists(join(source, "keybindings.json"), join(dest, "keybindings.json"));
  copyDirIfExists(join(source, "skills"), join(dest, "skills"));
  copyDirIfExists(join(source, "extensions"), join(dest, "extensions"));

  const ghToken = join(dest, "gh-token");
  writeFileSync(ghToken, `${hostGitHubToken()}\n`, { mode: 0o600 });
  chmodSync(ghToken, 0o600);
  return dest;
}

function ensureImage(): void {
  if (existsSync(IMAGE)) {
    return;
  }

  console.error(`${IMAGE} not found — running bake first…`);
  const result = spawnSync(process.execPath, [join(ROOT, "bake.ts")], { stdio: "inherit" });
  if ((result.status ?? 1) !== 0) {
    process.exit(statusCode(result));
  }
}

function ensureHostMounts(vmStateDir: string): void {
  for (const dir of ["node_modules", "pnpm-store"]) {
    mkdirSync(join(vmStateDir, dir), { recursive: true });
  }
}

function parsePortForward(): string[] {
  const raw = process.env.MACHINEN_VM_PORTS || process.env.MACHINEN_VM_PORT;
  if (!raw?.trim()) {
    return [];
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(":");
      if (parts.length > 2) {
        fail(`Invalid MACHINEN_VM_PORTS entry: ${entry}`);
      }
      const [host, guest = host] = parts;
      if (!/^\d+$/.test(host) || !/^\d+$/.test(guest)) {
        fail(`Invalid MACHINEN_VM_PORTS entry: ${entry}`);
      }
      const hostPort = Number(host);
      const guestPort = Number(guest);
      if (hostPort < 1 || hostPort > 65535 || guestPort < 1 || guestPort > 65535) {
        fail(`Invalid MACHINEN_VM_PORTS entry: ${entry}`);
      }
      return `${hostPort}:${guestPort}`;
    });
}

function bootVm(name: string, worktree: Worktree, vmStateDir: string, piAgent: string): void {
  const args = [
    "boot",
    IMAGE,
    "--name",
    name,
    "--cwd",
    GUEST_WORKSPACE,
    "--mount-live",
    `${worktree.path}:${GUEST_WORKSPACE}:rw`,
    "--mount-live",
    `${join(vmStateDir, "node_modules")}:${GUEST_NODE_MODULES}:rw`,
    "--mount-live",
    `${join(vmStateDir, "pnpm-store")}:${GUEST_PNPM_STORE}:rw`,
    "--mount-live",
    `${worktree.gitCommonDir}:${GUEST_GIT_COMMON}:rw`,
    "--mount-live",
    `${piAgent}:${GUEST_PI_AGENT}:rw`,
    "--detach",
    "--json",
  ];

  for (const port of parsePortForward()) {
    args.push("-p", port);
  }

  console.error(`booting ${name} — worktree=${worktree.path}`);
  machinenOutput(args, true);
}

function configureVm(name: string, worktree: Worktree): void {
  const installDeps =
    process.env.MACHINEN_VM_SKIP_INSTALL === "1"
      ? ""
      : `
cd ${GUEST_WORKSPACE}
if [ ! -f node_modules/.modules.yaml ]; then
  pnpm install --frozen-lockfile
fi
`;

  vmSh(
    name,
    `set -euo pipefail
mkdir -p /root/.pi ${GUEST_WORKSPACE} ${GUEST_PI_AGENT} ${GUEST_PNPM_STORE} ${GUEST_GIT_COMMON} ${GUEST_NODE_MODULES}
rm -rf /root/.pi/agent
ln -sfn ${GUEST_PI_AGENT} /root/.pi/agent
cat > /root/.agent-ci-vm-env <<'EOF'
${guestGitExports(worktree)}
EOF
if ! grep -qxF '. /root/.agent-ci-vm-env' /root/.bashrc; then
  printf '\n. /root/.agent-ci-vm-env\n' >> /root/.bashrc
fi
. /root/.agent-ci-vm-env
git config --global --add safe.directory ${GUEST_WORKSPACE} || true
git -C ${GUEST_WORKSPACE} status --short >/dev/null
pnpm config set --global store-dir ${GUEST_PNPM_STORE}
if ! command -v gh >/dev/null; then
  echo "gh is not installed in this VM image. Remove .machinen/rootfs.tar.gz and rerun pnpm vm." >&2
  exit 1
fi
GH_TOKEN_FILE=${GUEST_PI_AGENT}/gh-token
if [ -s "$GH_TOKEN_FILE" ]; then
  trap 'rm -f "$GH_TOKEN_FILE"' EXIT
  rm -rf /root/.config/gh
  mkdir -p /root/.config/gh
  gh auth login --hostname github.com --git-protocol https --with-token < "$GH_TOKEN_FILE"
  gh auth setup-git --hostname github.com
  rm -f "$GH_TOKEN_FILE"
  trap - EXIT
fi
gh auth status --hostname github.com >/dev/null
${installDeps}`,
  );
}

function printReady(name: string, worktree: string, vmStateDir: string, vm?: VmEntry): void {
  const portLines = (vm?.ports ?? [])
    .map((port) => `  http://localhost:${port.hostPort} -> guest:${port.guestPort}`)
    .join("\n");

  console.error(`
${name} is ready.

PI.dev starts directly when you attach.

  attach PI:    pnpm vm
  attach shell: pnpm vm shell
  snapshot:     pnpm vm snapshot
  stop VM:      pnpm vm stop

Worktree:       ${worktree} -> ${GUEST_WORKSPACE}
Git metadata:   mounted at ${GUEST_GIT_COMMON}
node_modules:   ${join(vmStateDir, "node_modules")} -> ${GUEST_NODE_MODULES}
pnpm store:     ${join(vmStateDir, "pnpm-store")} -> ${GUEST_PNPM_STORE}${portLines ? `\nPorts:\n${portLines}` : ""}
`);
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function snapshotVm(name: string, branch: string): never {
  if (!runningVm(name)) {
    fail(`${name} is not running. Start it first with \`pnpm vm\` from this worktree.`);
  }

  const outDir = join(SNAPSHOT_ROOT, branch, timestamp());
  mkdirSync(dirname(outDir), { recursive: true });
  machinen(["snapshot", name, outDir, "--keep-alive"]);
  console.error(`snapshot written to ${outDir}`);
  process.exit(0);
}

function stopVm(name: string): never {
  if (!runningVm(name)) {
    console.error(`${name} is not running.`);
    process.exit(0);
  }

  machinen(["stop", name]);
  process.exit(0);
}

function attachVm(name: string, shell: string): never {
  const result = spawnSync(MACHINEN, ["attach", name, "--shell", shell], { stdio: "inherit" });
  process.exit(statusCode(result));
}

const cmd = command();
mkdirSync(MACHINEN_DIR, { recursive: true });

const worktree = currentWorktree();
const vmName = process.env.MACHINEN_VM_NAME?.trim() || worktree.branch;
const vmStateDir = join(MACHINEN_DIR, "vms", worktree.branch);

if (cmd === "snapshot") {
  snapshotVm(vmName, worktree.branch);
}
if (cmd === "stop") {
  stopVm(vmName);
}

ensureHostMounts(vmStateDir);
let vmEntry = runningVm(vmName);
if (!vmEntry) {
  ensureImage();
}

const piAgent = ensurePiAgent(vmStateDir);
if (vmEntry) {
  console.error(`${vmName} is already running — ensuring PI.dev is configured…`);
} else {
  bootVm(vmName, worktree, vmStateDir, piAgent);
  vmEntry = runningVm(vmName);
}

configureVm(vmName, worktree);
printReady(vmName, worktree.path, vmStateDir, vmEntry ?? runningVm(vmName));

if (process.env.MACHINEN_VM_NO_ATTACH === "1") {
  process.exit(0);
}

attachVm(vmName, cmd === "shell" ? "/bin/bash -i" : piCommand(worktree));
