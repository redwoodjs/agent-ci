import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { provision } from "@machinen/runtime";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MACHINEN = join(
  ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "machinen.cmd" : "machinen",
);
const MACHINEN_DIR = join(ROOT, ".machinen");
const IMAGE = join(MACHINEN_DIR, "rootfs.tar.gz");

const NODE_VERSION = process.env.MACHINEN_VM_NODE_VERSION ?? "24";
const PNPM_VERSION = process.env.MACHINEN_VM_PNPM_VERSION ?? "10.30.1";
const PI_PACKAGE = process.env.PI_NPM_PACKAGE ?? "@earendil-works/pi-coding-agent";
const RUNTIME_VERSION = JSON.parse(
  readFileSync(join(ROOT, "node_modules", "@machinen", "runtime", "package.json"), "utf8"),
).version as string;

for (const [name, value] of Object.entries({ NODE_VERSION, PNPM_VERSION, PI_PACKAGE })) {
  if (!/^[\w@./+-]+$/.test(value)) {
    throw new Error(`${name} contains unsupported shell characters: ${value}`);
  }
}

function runMachinen(args: string[]): void {
  const result = spawnSync(MACHINEN, args, { stdio: "inherit" });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function bash(script: string): string {
  return `bash -lc ${shellQuote(script)}`;
}

mkdirSync(MACHINEN_DIR, { recursive: true });
if (!process.env.MACHINEN_ASSETS_DIR) {
  runMachinen(["install", "--version", `runtime-v${RUNTIME_VERSION}`]);
}

await provision({
  install: async (vm) => {
    await vm.exec(
      bash(`
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  fd-find \
  gh \
  git \
  libatomic1 \
  ripgrep
rm -rf /var/lib/apt/lists/*

export FNM_DIR=/opt/fnm
fnm install ${NODE_VERSION}
fnm default ${NODE_VERSION}
npm install -g pnpm@${PNPM_VERSION} ${PI_PACKAGE}
ln -sf /usr/bin/fdfind /usr/local/bin/fd
node --version
npm --version
pnpm --version
pi --version

mkdir -p /mnt/workspace /mnt/pi-agent /mnt/pnpm-store /root/.pi
rm -rf /root/.pi/agent
ln -sfn /mnt/pi-agent /root/.pi/agent
git config --global --add safe.directory /mnt/workspace || true
cat > /root/.bashrc <<'EOF'
export HOME=/root
export SHELL=/bin/bash
export TERM=\${TERM:-xterm-256color}
export PI_CODING_AGENT_DIR=/root/.pi/agent
cd /mnt/workspace 2>/dev/null || true
EOF
`),
      { execTimeoutMs: null },
    );
  },
  cmd: ["/bin/sleep", "infinity"],
  env: {
    HOME: "/root",
    SHELL: "/bin/bash",
    TERM: "xterm-256color",
    PI_CODING_AGENT_DIR: "/root/.pi/agent",
  },
  out: IMAGE,
});

console.log(`baked ${IMAGE}`);
