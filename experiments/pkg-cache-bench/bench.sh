#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Package Manager Cache Benchmark
#
# Measures install speed across 4 scenarios for NPM, Yarn, and Bun:
#   1. Cold install   — no cache, no node_modules
#   2. Warm cache     — global cache populated, no node_modules
#   3. Warm modules   — pre-populated node_modules, incremental install
#   4. Symlink only   — symlink cached node_modules (skip install entirely)
#
# Usage:
#   bash bench.sh                  # run all package managers
#   bash bench.sh --pm npm         # run NPM only
#   bash bench.sh --pm yarn        # run Yarn only
#   bash bench.sh --pm bun         # run Bun only
#   bash bench.sh --pm npm,yarn    # run NPM + Yarn
# ──────────────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BENCH_DIR="/tmp/pkg-cache-bench"
RESULTS_FILE="$SCRIPT_DIR/results.txt"
WORK="$BENCH_DIR/work"

# ── Argument parsing ──
PM_FILTER="npm,yarn,bun"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pm) PM_FILTER="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ── Helpers ──

now_ms() {
  # macOS: python3 for ms precision (date doesn't support %N)
  python3 -c 'import time; print(int(time.time()*1000))'
}

time_cmd() {
  local label="$1"; shift
  local t0; t0=$(now_ms)
  if "$@" >/dev/null 2>&1; then
    :
  else
    echo "    [warning] command exited non-zero: $*"
  fi
  local t1; t1=$(now_ms)
  local ms=$(( t1 - t0 ))
  local secs
  secs=$(awk "BEGIN {printf \"%.1f\", $ms / 1000}")
  echo "  ⏱  $label: ${secs}s"
  echo "$label|${secs}s" >> "$RESULTS_FILE"
}

reset_work() {
  rm -rf "$WORK"
  mkdir -p "$WORK"
  # Copy package.json but strip pnpm-specific config so all PMs work
  python3 -c "
import json, sys
with open('$SCRIPT_DIR/package.json') as f:
    pkg = json.load(f)
pkg.pop('pnpm', None)
pkg.pop('packageManager', None)
with open('$WORK/package.json', 'w') as f:
    json.dump(pkg, f, indent=2)
"
}

# ── Setup ──
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║  Package Manager Cache Benchmark (create-rwsdk project)  ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

rm -rf "$BENCH_DIR"
mkdir -p "$BENCH_DIR"
> "$RESULTS_FILE"

# ──────────────────────────────────────────────────────────────────
# NPM
# ──────────────────────────────────────────────────────────────────
run_npm() {
  echo "━━━ NPM $(npm --version 2>/dev/null) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "NPM|---" >> "$RESULTS_FILE"

  local cache="$BENCH_DIR/npm-cache"
  local warm="$BENCH_DIR/npm-warm-modules"

  # Generate lockfile
  echo "  [prep] Generating package-lock.json..."
  reset_work
  npm install --prefix "$WORK" --cache "$cache" >/dev/null 2>&1
  cp "$WORK/package-lock.json" "$BENCH_DIR/package-lock.json"

  # 1. Cold install
  echo ""
  echo "  Scenario 1: Cold install (no cache, no node_modules)"
  rm -rf "$cache"
  reset_work
  cp "$BENCH_DIR/package-lock.json" "$WORK/"
  time_cmd "npm-cold" npm ci --prefix "$WORK" --cache "$cache"

  # 2. Warm cache only
  echo "  Scenario 2: Warm global cache (no node_modules)"
  reset_work
  cp "$BENCH_DIR/package-lock.json" "$WORK/"
  time_cmd "npm-warm-cache" npm ci --prefix "$WORK" --cache "$cache"

  # 3. Warm node_modules (incremental)
  echo "  Scenario 3: Warm node_modules (npm install — incremental)"
  time_cmd "npm-warm-modules" npm install --prefix "$WORK" --cache "$cache"

  # Save warm modules for scenario 4
  rm -rf "$warm"
  cp -a "$WORK/node_modules" "$warm"

  # 4. Symlink cached node_modules
  echo "  Scenario 4: Symlink warm node_modules (no install)"
  reset_work
  time_cmd "npm-symlink" ln -sfn "$warm" "$WORK/node_modules"

  echo ""
}

# ──────────────────────────────────────────────────────────────────
# Yarn (v3+ Berry)
# ──────────────────────────────────────────────────────────────────
run_yarn() {
  # Detect yarn version from /tmp to avoid monorepo packageManager interference
  local version
  version=$(cd /tmp && yarn --version 2>/dev/null || echo "0")
  local major="${version%%.*}"

  echo "━━━ Yarn $version ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Yarn|---" >> "$RESULTS_FILE"

  local cache="$BENCH_DIR/yarn-cache"
  local warm="$BENCH_DIR/yarn-warm-modules"

  # Helper: run yarn install inside WORK dir (cd avoids --cwd traversal)
  yarn_install() {
    (cd "$WORK" && yarn install "$@" >/dev/null 2>&1) || true
  }

  # Helper to prepare work for yarn
  setup_yarn_work() {
    reset_work
    cp "$BENCH_DIR/yarn.lock" "$WORK/" 2>/dev/null || true
    if [[ "$major" -ge 2 ]]; then
      cat > "$WORK/.yarnrc.yml" <<EOF
nodeLinker: node-modules
enableGlobalCache: false
cacheFolder: "$cache"
EOF
    fi
  }

  # Generate lockfile
  echo "  [prep] Generating yarn.lock..."
  reset_work
  if [[ "$major" -ge 2 ]]; then
    cat > "$WORK/.yarnrc.yml" <<EOF
nodeLinker: node-modules
enableGlobalCache: false
cacheFolder: "$cache"
EOF
    yarn_install
  else
    (cd "$WORK" && yarn install --cache-folder "$cache" --non-interactive >/dev/null 2>&1) || true
  fi
  cp "$WORK/yarn.lock" "$BENCH_DIR/yarn.lock" 2>/dev/null || true

  # 1. Cold install
  echo ""
  echo "  Scenario 1: Cold install (no cache, no node_modules)"
  rm -rf "$cache"
  setup_yarn_work
  if [[ "$major" -ge 2 ]]; then
    time_cmd "yarn-cold" bash -c "cd '$WORK' && yarn install"
  else
    time_cmd "yarn-cold" bash -c "cd '$WORK' && yarn install --cache-folder '$cache' --frozen-lockfile --non-interactive"
  fi

  # 2. Warm cache only
  echo "  Scenario 2: Warm global cache (no node_modules)"
  setup_yarn_work
  if [[ "$major" -ge 2 ]]; then
    time_cmd "yarn-warm-cache" bash -c "cd '$WORK' && yarn install"
  else
    time_cmd "yarn-warm-cache" bash -c "cd '$WORK' && yarn install --cache-folder '$cache' --frozen-lockfile --non-interactive"
  fi

  # 3. Warm node_modules (incremental)
  echo "  Scenario 3: Warm node_modules (yarn install — incremental)"
  if [[ "$major" -ge 2 ]]; then
    time_cmd "yarn-warm-modules" bash -c "cd '$WORK' && yarn install"
  else
    time_cmd "yarn-warm-modules" bash -c "cd '$WORK' && yarn install --cache-folder '$cache' --non-interactive"
  fi

  # Save warm modules
  rm -rf "$warm"
  cp -a "$WORK/node_modules" "$warm" 2>/dev/null || true

  # 4. Symlink
  echo "  Scenario 4: Symlink warm node_modules (no install)"
  reset_work
  time_cmd "yarn-symlink" ln -sfn "$warm" "$WORK/node_modules"

  echo ""
}

# ──────────────────────────────────────────────────────────────────
# Bun
# ──────────────────────────────────────────────────────────────────
run_bun() {
  if ! command -v bun &>/dev/null; then
    echo "━━━ Bun (not installed — skipping) ━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ⚠ Install: curl -fsSL https://bun.sh/install | bash"
    echo ""
    return
  fi

  echo "━━━ Bun $(bun --version 2>/dev/null) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Bun|---" >> "$RESULTS_FILE"

  local cache="$BENCH_DIR/bun-cache"
  local warm="$BENCH_DIR/bun-warm-modules"

  # Generate lockfile
  echo "  [prep] Generating bun.lock..."
  reset_work
  BUN_INSTALL_CACHE_DIR="$cache" bun install --cwd "$WORK" >/dev/null 2>&1
  cp "$WORK/bun.lock" "$BENCH_DIR/bun.lock" 2>/dev/null || cp "$WORK/bun.lockb" "$BENCH_DIR/bun.lockb" 2>/dev/null || true

  # 1. Cold install
  echo ""
  echo "  Scenario 1: Cold install (no cache, no node_modules)"
  rm -rf "$cache"
  reset_work
  cp "$BENCH_DIR"/bun.lock* "$WORK/" 2>/dev/null || true
  time_cmd "bun-cold" env BUN_INSTALL_CACHE_DIR="$cache" bun install --cwd "$WORK" --frozen-lockfile

  # 2. Warm cache only
  echo "  Scenario 2: Warm global cache (no node_modules)"
  reset_work
  cp "$BENCH_DIR"/bun.lock* "$WORK/" 2>/dev/null || true
  time_cmd "bun-warm-cache" env BUN_INSTALL_CACHE_DIR="$cache" bun install --cwd "$WORK" --frozen-lockfile

  # 3. Warm node_modules (incremental)
  echo "  Scenario 3: Warm node_modules (bun install — incremental)"
  time_cmd "bun-warm-modules" env BUN_INSTALL_CACHE_DIR="$cache" bun install --cwd "$WORK"

  # Save warm modules
  rm -rf "$warm"
  cp -a "$WORK/node_modules" "$warm"

  # 4. Symlink
  echo "  Scenario 4: Symlink warm node_modules (no install)"
  reset_work
  time_cmd "bun-symlink" ln -sfn "$warm" "$WORK/node_modules"

  echo ""
}

# ── Dispatch ──
if echo "$PM_FILTER" | grep -qi "npm\|all"; then run_npm; fi
if echo "$PM_FILTER" | grep -qi "yarn\|all"; then run_yarn; fi
if echo "$PM_FILTER" | grep -qi "bun\|all"; then run_bun; fi

# ──────────────────────────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────────────────────────
echo "╔═══════════════════════════╗"
echo "║  Results Summary          ║"
echo "╚═══════════════════════════╝"
echo ""
printf "  %-24s %s\n" "Scenario" "Time"
printf "  %-24s %s\n" "────────────────────────" "──────"

while IFS='|' read -r label time; do
  if [[ "$time" == "---" ]]; then
    echo ""
    echo "  [$label]"
  else
    printf "  %-24s %s\n" "$label" "$time"
  fi
done < "$RESULTS_FILE"

echo ""
echo "Raw results: $RESULTS_FILE"
echo ""
