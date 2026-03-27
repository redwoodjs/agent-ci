#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "agent-ci wrapper: Node.js is required." >&2
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${node_major}" -lt 22 ]; then
  echo "agent-ci wrapper: Node.js 22 or newer is required. Found $(node -v)." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "agent-ci wrapper: Docker is required and must be on PATH." >&2
  exit 1
fi

repo_root="$(pwd)"
local_bin="${repo_root}/node_modules/.bin/agent-ci"

if [ -x "${local_bin}" ]; then
  exec "${local_bin}" "$@"
fi

exec npx --yes @redwoodjs/agent-ci "$@"
