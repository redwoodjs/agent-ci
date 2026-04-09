#!/usr/bin/env bash
# Dev wrapper for agent-ci that works from any directory.
# Builds dtu-github-actions, then runs the CLI via tsx.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Build dtu-github-actions (suppress pnpm lifecycle noise)
pnpm --silent --dir "$REPO_ROOT/packages/dtu-github-actions" run build 2>/dev/null || \
  pnpm --dir "$REPO_ROOT/packages/dtu-github-actions" run build

# Run CLI from the caller's working directory
exec "$REPO_ROOT/node_modules/.bin/tsx" "$REPO_ROOT/packages/cli/src/cli.ts" "$@"
