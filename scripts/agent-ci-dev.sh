#!/usr/bin/env bash
# Dev-only wrapper: runs agent-ci against local development code (via tsx)
# instead of the published package. Not intended for end users.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Build dtu-github-actions (suppress pnpm lifecycle noise)
pnpm --silent --dir "$REPO_ROOT/packages/dtu-github-actions" run build 2>/dev/null || \
  pnpm --dir "$REPO_ROOT/packages/dtu-github-actions" run build

# Run CLI from the caller's working directory
exec "$REPO_ROOT/node_modules/.bin/tsx" "$REPO_ROOT/packages/cli/src/cli.ts" "$@"
