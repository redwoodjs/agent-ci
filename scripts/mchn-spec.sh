#!/bin/bash

# Machinen Speccing Engine - Autonomous Driver
# Usage: ./scripts/mchn-spec.sh "<PROMPT>"
# or: echo "<PROMPT>" | ./scripts/mchn-spec.sh -

set -e

# Configuration
DEFAULT_WORKER_URL="https://machinen.redwoodjs.workers.dev"
WORKER_URL="${MACHINEN_ENGINE_URL:-$DEFAULT_WORKER_URL}"

if [ -z "$API_KEY" ]; then
  echo "Error: API_KEY environment variable not set." >&2
  exit 1
fi

# Argument Parsing
PROMPT="$1"
if [ -z "$PROMPT" ]; then
  echo "Usage: $0 \"<PROMPT>\" [--mode server|client]" >&2
  exit 1
fi

if [ "$PROMPT" = "-" ]; then
  PROMPT=$(cat)
fi

MODE="server"
# Check if --mode is provided as second or third argument
for arg in "$@"; do
  if [ "$arg" = "--mode" ]; then
    # The next argument is the mode
    # simplified for this script
    :
  elif [ "$arg" = "client" ] || [ "$arg" = "server" ]; then
    MODE="$arg"
  fi
done

# Helper: Post with Retry
function post_with_retry() {
  local URL="$1"
  local DATA="$2"
  local HEADERS_FILE="$3"
  local BODY_FILE="$4"
  local ATTEMPT=1
  local MAX_ATTEMPTS=5
  local WAIT=2

  while [ "$ATTEMPT" -le "$MAX_ATTEMPTS" ]; do
    # Clear temp files
    : > "$HEADERS_FILE"
    : > "$BODY_FILE"

    # Use --no-buffer and -N for streaming
    # We pipe output to SPEC_FILE immediately if it's the stream endpoint
    if [[ "$URL" == *"stream"* ]]; then
      # Live stream directly into SPEC_FILE
      curl -N -s --no-buffer -X POST "$URL" \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/json" \
        -d "$DATA" \
        -D "$HEADERS_FILE" | tee "$SPEC_FILE" > "$BODY_FILE"
    else
      curl -s -X POST "$URL" \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/json" \
        -d "$DATA" \
        -D "$HEADERS_FILE" > "$BODY_FILE"
    fi

    local STATUS_CODE=$(grep "HTTP/" "$HEADERS_FILE" | tail -1 | awk '{print $2}')
    
    # Success cases
    if [ "$STATUS_CODE" = "200" ]; then
      return 0
    fi

    # Check for quota error in body even if status is 200 (LLM streaming error)
    if grep -q "token_quota_exceeded" "$BODY_FILE" 2>/dev/null; then
       STATUS_CODE="429"
    fi

    # Retryable errors
    if [ "$STATUS_CODE" = "429" ] || [ "$STATUS_CODE" = "500" ] || [ -z "$STATUS_CODE" ]; then
      echo "⚠️  Attempt $ATTEMPT/$MAX_ATTEMPTS: Status $STATUS_CODE. Retrying in ${WAIT}s..." >&2
      sleep "$WAIT"
      WAIT=$((WAIT * 2))
      ATTEMPT=$((ATTEMPT + 1))
    else
      # Hard error
      return 1
    fi
  done

  return 1
}

# 1. Detect Environment Context
# ... (same)
REPOSITORY=$(git remote -v 2>/dev/null | grep 'origin.*(fetch)' | head -n 1 | sed -E 's/.*github.com[:\/](.*)\.git.*/\1/' | sed 's/.*github.com[:\/]//')
if [ -z "$REPOSITORY" ]; then
  REPOSITORY=$(basename "$(pwd)")
fi

# 2. Discovery
echo "--- Searching for relevant subject ---" >&2
HEADERS_TMP=$(mktemp)
BODY_TMP=$(mktemp)

post_with_retry "$WORKER_URL/api/subjects/search" \
  "{ \"query\": \"$PROMPT\", \"context\": { \"repository\": \"$REPOSITORY\", \"namespacePrefix\": \"$NAMESPACE_PREFIX\" } }" \
  "$HEADERS_TMP" "$BODY_TMP"

SUBJECT_ID=$(echo "$(cat "$BODY_TMP")" | jq -r '.matches[0].id')
SUBJECT_TITLE=$(echo "$(cat "$BODY_TMP")" | jq -r '.matches[0].title')

if [ "$SUBJECT_ID" = "null" ] || [ -z "$SUBJECT_ID" ]; then
  echo "Error: No matching subject found for prompt: $PROMPT" >&2
  exit 1
fi

echo "Found Subject: $SUBJECT_TITLE" >&2

# 3. Initialization
SESSION_SLUG=$(echo "$SUBJECT_TITLE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')
SESSION_ID="${SESSION_SLUG:-session}-$((1000 + RANDOM % 9000))"
SPEC_FILE="docs/specs/${SESSION_ID}.md"

echo "--- Initializing Speccing Session ---" >&2
echo "Target File: $SPEC_FILE" >&2
mkdir -p docs/specs
touch "$SPEC_FILE"

post_with_retry "$WORKER_URL/api/speccing/start?subjectId=$SUBJECT_ID&sessionId=$SESSION_ID" \
  "{ \"revisionMode\": \"$MODE\", \"context\": { \"repository\": \"$REPOSITORY\", \"namespacePrefix\": \"$NAMESPACE_PREFIX\" } }" \
  "$HEADERS_TMP" "$BODY_TMP"

RETURNED_SESSION_ID=$(echo "$(cat "$BODY_TMP")" | jq -r '.sessionId')
if [ "$RETURNED_SESSION_ID" = "null" ] || [ -z "$RETURNED_SESSION_ID" ]; then
  echo "Error: Failed to initialize session: $(cat "$BODY_TMP")" >&2
  exit 1
fi

# 4. Autonomous Loop
TURN=1

while true; do
  echo "--- Turn $TURN: Streaming refinements ---" >&2
  
  if ! post_with_retry "$WORKER_URL/api/speccing/next/stream?sessionId=$SESSION_ID" \
    "{ \"userPrompt\": \"$PROMPT\" }" \
    "$HEADERS_TMP" "$BODY_TMP"; then
    echo "Error: Persistent failure after retries." >&2
    exit 1
  fi

  # Check metadata header (expected to be Base64 encoded)
  METADATA_B64=$(grep -i "x-speccing-metadata:" "$HEADERS_TMP" | sed 's/[Xx]-[Ss]peccing-[Mm]etadata: //I' | tr -d '\r')
  
  if [ -n "$METADATA_B64" ]; then
    METADATA_JSON=$(echo "$METADATA_B64" | base64 -D 2>/dev/null || echo "$METADATA_B64" | base64 -d 2>/dev/null)
  fi

  if [ -z "$METADATA_JSON" ]; then
    # Maybe it was a completion/status JSON
    if jq -e . "$BODY_TMP" >/dev/null 2>&1; then
      STATUS=$(jq -r '.status' "$BODY_TMP")
      if [ "$STATUS" = "completed" ]; then
         echo "--- Speccing Complete ---" >&2
         rm -f "$HEADERS_TMP" "$BODY_TMP"
         break
      fi
    fi
    echo "Error: Failed to get metadata or valid response" >&2
    rm -f "$HEADERS_TMP" "$BODY_TMP"
    exit 1
  fi

  MOMENT_TITLE=$(echo "$METADATA_JSON" | jq -r '.moment.title')
  echo "✅ Turn $TURN complete. Processed: $MOMENT_TITLE" >&2
  echo "Updated $SPEC_FILE" >&2
  
  rm -f "$HEADERS_TMP" "$BODY_TMP"
  TURN=$((TURN + 1))
done

echo "Final Specification saved to: $SPEC_FILE"
echo "Open it now to review the results."
