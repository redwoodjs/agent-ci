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

# 1. Detect Environment Context
REPOSITORY=$(git remote -v 2>/dev/null | grep 'origin.*(fetch)' | head -n 1 | sed -E 's/.*github.com[:\/](.*)\.git.*/\1/' | sed 's/.*github.com[:\/]//')
if [ -z "$REPOSITORY" ]; then
  REPOSITORY=$(basename "$(pwd)")
fi

# 2. Discovery
echo "--- Searching for relevant subject ---" >&2
SEARCH_RESPONSE=$(curl -s -X POST "$WORKER_URL/api/subjects/search" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{ \"query\": \"$PROMPT\", \"context\": { \"repository\": \"$REPOSITORY\", \"namespacePrefix\": \"$NAMESPACE_PREFIX\" } }")

SUBJECT_ID=$(echo "$SEARCH_RESPONSE" | jq -r '.matches[0].id')
SUBJECT_TITLE=$(echo "$SEARCH_RESPONSE" | jq -r '.matches[0].title')

if [ "$SUBJECT_ID" = "null" ] || [ -z "$SUBJECT_ID" ]; then
  echo "Error: No matching subject found for prompt: $PROMPT" >&2
  exit 1
fi

echo "Found Subject: $SUBJECT_TITLE" >&2

# 3. Initialization
echo "--- Initializing Speccing Session ---" >&2
START_RESPONSE=$(curl -s -X POST "$WORKER_URL/api/speccing/start?subjectId=$SUBJECT_ID" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{ \"revisionMode\": \"$MODE\", \"context\": { \"repository\": \"$REPOSITORY\", \"namespacePrefix\": \"$NAMESPACE_PREFIX\" } }")

SESSION_ID=$(echo "$START_RESPONSE" | jq -r '.sessionId')

if [ "$SESSION_ID" = "null" ] || [ -z "$SESSION_ID" ]; then
  echo "Error: Failed to initialize session: $START_RESPONSE" >&2
  exit 1
fi

echo "Session Started: $SESSION_ID" >&2

# 4. Autonomous Loop
TURN=1
SPEC_FILE="docs/specs/${SESSION_ID}.md"
mkdir -p docs/specs

while true; do
  # Call /next/stream
  echo "--- Turn $TURN: Streaming refinements ---" >&2
  
  HEADERS_TMP=$(mktemp)
  # Stream the body directly into the SPEC_FILE for immediate visibility
  # We still record to BODY_TMP to check for JSON errors after the fact
  BODY_TMP=$(mktemp)
  
  # Note: if it's an error, SPEC_FILE will temporarily contain JSON. 
  # This is acceptable for "live" mode as we'll handle it after curl finishes.
  curl -N -s -X POST "$WORKER_URL/api/speccing/next/stream?sessionId=$SESSION_ID" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{ \"userPrompt\": \"$PROMPT\" }" \
    -D "$HEADERS_TMP" | tee "$SPEC_FILE" > "$BODY_TMP"

  # Check metadata header
  METADATA_JSON=$(grep -i "x-speccing-metadata:" "$HEADERS_TMP" | sed 's/[Xx]-[Ss]peccing-[Mm]etadata: //I' | tr -d '\r')
  
  if [ -z "$METADATA_JSON" ]; then
    # Maybe it was a JSON response (completion or error)
    if jq -e . "$BODY_TMP" >/dev/null 2>&1; then
      STATUS=$(jq -r '.status' "$BODY_TMP")
      if [ "$STATUS" = "completed" ]; then
         echo "--- Speccing Complete ---" >&2
         rm -f "$HEADERS_TMP" "$BODY_TMP"
         break
      fi
      ERROR=$(jq -r '.error' "$BODY_TMP")
      if [ "$ERROR" != "null" ]; then
         echo "Error: $ERROR" >&2
         # Restore potentially corrupted SPEC_FILE or just exit
         rm -f "$HEADERS_TMP" "$BODY_TMP"
         exit 1
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
