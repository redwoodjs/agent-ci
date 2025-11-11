#!/bin/bash

# Filter wrangler tail logs to show only application logs
#
# Usage:
#   ./scripts/filter-logs.sh [log-file]
#   cat out.log | ./scripts/filter-logs.sh
#   npx wrangler tail rag-experiment-1 --format=json | ./scripts/filter-logs.sh

# Filter pattern for our application log prefixes
LOG_PATTERN="\\[(cron|queue|engine|scanner|indexing|query|db)\\]"

# If a file is provided, read from it; otherwise read from stdin
if [ $# -gt 0 ]; then
  INPUT="$1"
else
  INPUT="-"
fi

# Process JSONL (one JSON object per line)
cat "$INPUT" | while IFS= read -r line; do
  # Skip empty lines
  [ -z "$line" ] && continue
  
  # Check if this line has logs matching our pattern
  has_matching_log=$(echo "$line" | jq -r --arg pattern "$LOG_PATTERN" '
    if .logs != null and (.logs | length) > 0 then
      .logs[] |
      if .message != null then
        if (.message | type) == "array" then
          .message[] | select(. | type == "string" and (. | test($pattern)))
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
  ' 2>/dev/null)
  
  # Also check for exceptions
  has_exception=$(echo "$line" | jq -r 'if .exceptions != null and (.exceptions | length) > 0 then "error" else empty end' 2>/dev/null)
  
  if [ -n "$has_matching_log" ] || [ -n "$has_exception" ]; then
    # Extract timestamp
    timestamp=$(echo "$line" | jq -r '.eventTimestamp // .timestamp // ""' 2>/dev/null)
    
    # Format timestamp if available
    if [ -n "$timestamp" ] && [ "$timestamp" != "null" ] && [ "$timestamp" != "" ]; then
      # Convert milliseconds to seconds and format date
      date_str=$(date -r "$((timestamp / 1000))" "+%Y-%m-%d %H:%M:%S" 2>/dev/null || echo "")
    fi
    
    # Print matching log messages
    echo "$line" | jq -r --arg pattern "$LOG_PATTERN" '
      if .logs != null and (.logs | length) > 0 then
        .logs[] |
        if .message != null then
          if (.message | type) == "array" then
            .message[] | select(. | type == "string" and (. | test($pattern)))
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
    
    # Print exceptions if any
    if [ -n "$has_exception" ]; then
      echo "$line" | jq -r '.exceptions[] | "EXCEPTION: \(.name // "Error"): \(.message // .)"' 2>/dev/null | while IFS= read -r exception; do
        if [ -n "$exception" ]; then
          if [ -n "$date_str" ]; then
            echo "[$date_str] $exception"
          else
            echo "$exception"
          fi
        fi
      done
    fi
  fi
done

