#!/bin/bash

# Tail wrangler logs with filtering to show only application logs
#
# Usage:
#   ./scripts/tail-logs.sh [worker-name]
#   ./scripts/tail-logs.sh rag-experiment-1

# Default worker name (can be overridden via command line argument)
DEFAULT_WORKER="rag-experiment-1"

WORKER_NAME="${1:-$DEFAULT_WORKER}"

npx wrangler tail "$WORKER_NAME" --format=json 2>&1 | stdbuf -oL jq -r 'select(.event.rpcMethod == null)' | stdbuf -oL tee out.log
