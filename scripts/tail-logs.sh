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
  source <(grep -v '^#' "$PROJECT_ROOT/.dev.vars" | grep '=')
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

# Tail logs and format them nicely
npx wrangler tail "$WORKER_NAME" --format=json --env "${CLOUDFLARE_ENV:-}" 2>&1 | \
  stdbuf -oL jq -r '
    select(.event.rpcMethod == null) |
    .logs[]? |
    "[" + (if .timestamp then (.timestamp / 1000 | strftime("%Y-%m-%d %H:%M:%S")) else "unknown" end) + "] [" + (.level // "log") + "] " + 
    (.message | map(if type == "object" then (. | tojson) else . end) | join(" "))
  ' 2>&1 | \
  stdbuf -oL tee out.log
