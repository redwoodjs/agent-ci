import fs from "node:fs";
import path from "node:path";

const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;

const SHIM_SCRIPT = `#!/usr/bin/env bash
set -uo pipefail

pm="$(basename "$0")"
upper_pm="$(printf '%s' "$pm" | tr '[:lower:]-' '[:upper:]_')"
real_var="AGENT_CI_REAL_\${upper_pm}"
real="\${!real_var:-}"

if [ -z "$real" ]; then
  search_path="$PATH:\${AGENT_CI_ORIGINAL_PATH:-}"
  IFS=':' read -r -a path_parts <<< "$search_path"
  for dir in "\${path_parts[@]}"; do
    candidate="$dir/$pm"
    if [ -x "$candidate" ] && [ "$candidate" != "$0" ]; then
      real="$candidate"
      break
    fi
  done
fi

if [ -z "$real" ]; then
  echo "[Agent CI Shim] Could not find the real $pm binary" >&2
  exit 127
fi

is_install_command=false
project_install=false

has_global_flag() {
  for arg in "$@"; do
    case "$arg" in
      -g|--global|--location=global)
        return 0
        ;;
    esac
  done
  return 1
}

has_package_arg() {
  for arg in "$@"; do
    case "$arg" in
      --)
        shift
        [ "$#" -gt 0 ] && return 0
        return 1
        ;;
      -*)
        ;;
      *)
        return 0
        ;;
    esac
    shift || true
  done
  return 1
}

if [ "$#" -gt 0 ] && ! has_global_flag "$@"; then
  subcommand="$1"
  shift
  case "$pm:$subcommand" in
    npm:ci)
      is_install_command=true
      project_install=true
      ;;
    npm:install|npm:i|pnpm:install|pnpm:i|yarn:install|bun:install)
      is_install_command=true
      if ! has_package_arg "$@"; then
        project_install=true
      fi
      ;;
  esac
  set -- "$subcommand" "$@"
fi

if [ "\${AGENT_CI_LOCAL:-}" != "true" ] || [ "$is_install_command" != "true" ]; then
  exec "$real" "$@"
fi

repo_key="\${GITHUB_REPOSITORY:-unknown-repo}"
repo_key="$(printf '%s' "$repo_key" | sed 's#[^A-Za-z0-9._-]#_#g')"
lockfile_hash="\${AGENT_CI_LOCKFILE_HASH:-no-lockfile}"
state_dir="\${RUNNER_TOOL_CACHE:-/opt/hostedtoolcache}/agent-ci-installs/\${repo_key}/\${lockfile_hash}"
lock_dir="\${state_dir}/install.lock"
command_hash="$(printf '%s\n' "$pm" "$@" | sha256sum | awk '{ print $1 }')"
ready_file="node_modules/.agent-ci-\${pm}-\${command_hash}.ready"

has_install_sentinel() {
  [ -f node_modules/.modules.yaml ] || \
    [ -f node_modules/.package-lock.json ] || \
    [ -f node_modules/.yarn-integrity ] || \
    [ -d node_modules/.cache ]
}

is_workspace_project() {
  [ -f pnpm-workspace.yaml ] || \
    ([ -f package.json ] && grep -q '"workspaces"' package.json)
}

can_reuse_project_install=true
if is_workspace_project; then
  can_reuse_project_install=false
fi

if [ "$project_install" = "true" ] && [ "$can_reuse_project_install" = "true" ] && [ -f "$ready_file" ] && has_install_sentinel; then
  echo "[Agent CI Shim] Reusing warm node_modules for: $pm $*"
  exit 0
fi

mkdir -p "$state_dir"

while ! mkdir "$lock_dir" 2>/dev/null; do
  if [ -f "$lock_dir/created-at" ]; then
    created_at="$(cat "$lock_dir/created-at" 2>/dev/null || echo 0)"
    now="$(date +%s)"
    if [ $((now - created_at)) -gt 600 ]; then
      rm -rf "$lock_dir"
      continue
    fi
  fi
  sleep 1
done

release_lock() {
  rm -rf "$lock_dir"
}
trap release_lock EXIT

date +%s > "$lock_dir/created-at"

if [ "$project_install" = "true" ] && [ "$can_reuse_project_install" = "true" ] && [ -f "$ready_file" ] && has_install_sentinel; then
  echo "[Agent CI Shim] Reusing warm node_modules for: $pm $*"
  exit 0
fi

echo "[Agent CI Shim] Serializing shared node_modules install: $pm $*"
set +e
"$real" "$@"
status=$?
set -e

if [ "$status" -eq 0 ] && [ "$project_install" = "true" ] && [ "$can_reuse_project_install" = "true" ] && has_install_sentinel; then
  touch "$ready_file"
fi

exit "$status"
`;

/**
 * Write package-manager shims into the runner shims directory.
 *
 * The runner prepends this directory to PATH and points BASH_ENV at the
 * generated function file so run steps still resolve the shim after setup
 * actions prepend their own tool paths. Inside local Agent CI containers,
 * these shims serialize package-manager install commands that write the shared
 * warm node_modules bind mount, and they skip duplicate project installs after a
 * ready marker proves the same command already populated the lockfile-keyed
 * cache. Non-install commands and non-Agent-CI environments pass through to the
 * real package-manager binary.
 */
export function writePackageManagerShims(shimsDir: string): void {
  fs.mkdirSync(shimsDir, { recursive: true, mode: 0o777 });
  for (const pm of PACKAGE_MANAGERS) {
    fs.writeFileSync(path.join(shimsDir, pm), SHIM_SCRIPT, { mode: 0o755 });
  }

  const bashEnv = PACKAGE_MANAGERS.map((pm) => `${pm}() { /tmp/agent-ci-shims/${pm} "$@"; }`).join(
    "\n",
  );
  fs.writeFileSync(path.join(shimsDir, "bash-env"), `${bashEnv}\n`, { mode: 0o644 });
}

export const __test_packageManagerShimScript = SHIM_SCRIPT;
