#!/usr/bin/env bash
# Dev-only wrapper: runs agent-ci against local development code instead of
# the published package. Uses Node's native TypeScript support (Node >=24).
# Not intended for end users.
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ "${AGENT_CI_FORCE_RUST:-}" == "1" && "${AGENT_CI_FORCE_TYPESCRIPT:-}" != "1" && "${AGENT_CI_FORCE_TS:-}" != "1" ]]; then
  cargo build --manifest-path "$REPO_ROOT/Cargo.toml" -p agent-ci
  exec "$REPO_ROOT/target/debug/agent-ci" "$@"
fi

# Build dtu-github-actions (suppress pnpm lifecycle noise)
pnpm --silent --dir "$REPO_ROOT/packages/dtu-github-actions" run build 2>/dev/null || \
  pnpm --dir "$REPO_ROOT/packages/dtu-github-actions" run build

# Run CLI from the caller's working directory
exec node "$REPO_ROOT/packages/cli/src/cli.ts" "$@"
