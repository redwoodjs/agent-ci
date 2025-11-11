#!/bin/bash

# Tail wrangler logs with filtering to show only application logs
#
# Usage:
#   ./scripts/tail-logs.sh [worker-name]
#   ./scripts/tail-logs.sh rag-experiment-1

WORKER_NAME="${1:-rag-experiment-1}"

# Filter pattern for our application log prefixes
LOG_PATTERN="\\[(cron|queue|engine|scanner|indexing|query|db)\\]"

npx wrangler tail "$WORKER_NAME" --format=json 2>&1 | while IFS= read -r line; do
  # Skip empty lines and non-JSON lines
  [ -z "$line" ] && continue
  
  # Extract timestamp (in shell, more compatible)
  timestamp=$(echo "$line" | jq -r '.eventTimestamp // empty' 2>/dev/null)
  if [ -n "$timestamp" ] && [ "$timestamp" != "null" ]; then
    date_str=$(date -r "$((timestamp / 1000))" "+%Y-%m-%d %H:%M:%S" 2>/dev/null || echo "")
  else
    date_str=""
  fi
  
  # Extract matching log messages
  echo "$line" | jq -r --arg pattern "$LOG_PATTERN" '
    if .logs != null and (.logs | length) > 0 then
      .logs[] |
      if .message != null then
        if (.message | type) == "array" then
          .message[] | 
          select(. | type == "string" and (. | test($pattern)))
        elif (.message | type) == "string" then
          select(. | test($pattern))
        else
          empty
        end
      else
        empty
      end
    else
      empty
    end
  ' 2>/dev/null | while IFS= read -r log_message; do
    if [ -n "$log_message" ]; then
      if [ -n "$date_str" ]; then
        echo "[$date_str] $log_message"
      else
        echo "$log_message"
      fi
    fi
  done
  
  # Extract exceptions
  echo "$line" | jq -r '.exceptions[]? | "EXCEPTION: \(.name // "Error"): \(.message // .)"' 2>/dev/null | while IFS= read -r exception; do
    if [ -n "$exception" ]; then
      if [ -n "$date_str" ]; then
        echo "[$date_str] $exception"
      else
        echo "$exception"
      fi
    fi
  done
done

