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
  echo "--- Turn $TURN: Fetching next moment ---" >&2
  
  # Call /next
  NEXT_RESPONSE=$(curl -s -X POST "$WORKER_URL/api/speccing/next?sessionId=$SESSION_ID" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{ \"userPrompt\": \"$PROMPT\" }")

  # Validate JSON
  if ! echo "$NEXT_RESPONSE" | jq . >/dev/null 2>&1; then
    echo "Error: Backend returned non-JSON response: $NEXT_RESPONSE" >&2
    exit 1
  fi

  STATUS=$(echo "$NEXT_RESPONSE" | jq -r '.status')

  if [ "$STATUS" = "completed" ]; then
    echo "--- Speccing Complete ---" >&2
    break
  fi

  if [ "$STATUS" = "not_found" ] || [ "$STATUS" = "failed" ] || [ "$STATUS" = "null" ]; then
    echo "Error: Session $STATUS - $NEXT_RESPONSE" >&2
    exit 1
  fi

  # Extract revised spec or evidence
  if [ "$MODE" = "server" ]; then
    REVISED_SPEC=$(echo "$NEXT_RESPONSE" | jq -r '.revisedSpec')
    if [ "$REVISED_SPEC" != "null" ]; then
      echo "$REVISED_SPEC" > "$SPEC_FILE"
      echo "✅ Turn $TURN complete. Updated $SPEC_FILE" >&2
    else
      echo "Warning: No revisedSpec returned in server mode." >&2
    fi
  else
    # Client Mode - Output evidence for manual/agent use
    MOMENT_TITLE=$(echo "$NEXT_RESPONSE" | jq -r '.moment.title')
    echo "Client Mode: Moment '$MOMENT_TITLE' ready for revision." >&2
    echo "$NEXT_RESPONSE" | jq .
    # Note: In a real autonomous client mode, the script would need to invoke an LLM here.
    # For now, we print and wait (or rely on the IDE agent to handle the instructions).
    echo "Press Enter to continue to next turn..." >&2
    read _
  fi

  TURN=$((TURN + 1))
done

echo "Final Specification saved to: $SPEC_FILE"
echo "Open it now to review the results."
