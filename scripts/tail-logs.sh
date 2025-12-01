#!/bin/bash

# Tail wrangler logs with filtering to show only application logs
# Reads MACHINEN_ENV from .dev.vars to determine worker name
#
# Usage:
#   ./scripts/tail-logs.sh [worker-name-override]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load MACHINEN_ENV from .dev.vars
if [ -f "$PROJECT_ROOT/.dev.vars" ]; then
  set -a
  # Create a temp file with filtered vars and source it
  TEMP_VARS=$(mktemp)
  grep -v '^#' "$PROJECT_ROOT/.dev.vars" | grep '=' > "$TEMP_VARS"
  source "$TEMP_VARS"
  rm "$TEMP_VARS"
  set +a
fi

# Determine worker name from MACHINEN_ENV or command line override
if [ -n "$1" ]; then
  WORKER_NAME="$1"
elif [ -n "$MACHINEN_ENV" ]; then
  case "$MACHINEN_ENV" in
    "dev-justin")
      WORKER_NAME="machinen-dev-justin"
      ;;
    "production")
      WORKER_NAME="machinen"
      ;;
    *)
      WORKER_NAME="machinen"
      ;;
  esac
else
  WORKER_NAME="machinen"
fi

echo "Tailing logs for $WORKER_NAME (MACHINEN_ENV=${MACHINEN_ENV:-not set})" >&2

# Tail logs and format them nicely
# Note: Don't use --env flag, the worker name already includes the environment
# Redirect stderr to /dev/null to avoid binary/progress output from wrangler
npx wrangler tail "$WORKER_NAME" --format=json 2>/dev/null | \
  stdbuf -oL jq -r '
    select(.event.rpcMethod == null) |
    .logs[]? |
    "[" + (if .timestamp then (.timestamp / 1000 | strftime("%Y-%m-%d %H:%M:%S")) else "unknown" end) + "] [" + (.level // "log") + "] " + 
    (.message | map(if type == "object" then (. | tojson) else . end) | join(" "))
  ' 2>&1 | \
  stdbuf -oL grep -a . | \
  stdbuf -oL tee out.log
