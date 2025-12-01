#!/bin/bash

# Query the RAG engine
#
# Usage:
#   ./query.sh "your query here"
#   ./query.sh "your query" "http://localhost:8787" (uses API_KEY from env)
#   ./query.sh "your query" "your-api-key"
#   ./query.sh "your query" "your-api-key" "https://your-worker.workers.dev"
#
# Environment variables can also be used:
#   API_KEY="your-key" ./query.sh "your query"

# Auto-source .dev.vars if it exists (look in project root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load MACHINEN_ENV and API_KEY from .dev.vars
if [ -f "$PROJECT_ROOT/.dev.vars" ]; then
  # Preserve existing environment variables before sourcing .dev.vars
  # Save API_KEY if it exists
  SAVED_API_KEY="${API_KEY:-}"
  
  set -a
  # Create a temp file with filtered vars and source it (same method as tail-logs.sh)
  TEMP_VARS=$(mktemp)
  grep -v '^#' "$PROJECT_ROOT/.dev.vars" | grep '=' > "$TEMP_VARS"
  source "$TEMP_VARS"
  rm "$TEMP_VARS"
  set +a
  
  # Restore API_KEY if it was set in the environment before sourcing
  if [ -n "$SAVED_API_KEY" ]; then
    export API_KEY="$SAVED_API_KEY"
  fi
fi

# ==============================================================================
# Environment Configuration
# ==============================================================================
# Determine target environment from MACHINEN_ENV
# Precedence: CLI arg -> MACHINEN_ENV -> default (local)

# Default to local if not set
MACHINEN_ENV="${MACHINEN_ENV:-local}"

# Allow overriding with a command-line argument for one-off commands
if [[ "$1" == "--env" && -n "$2" ]]; then
  MACHINEN_ENV="$2"
  # Shift arguments so the rest of the script sees the query etc.
  shift 2
fi


# Parse positional arguments
# The query can be a string for a POST request, or a path for a GET request
QUERY_OR_PATH="${1:-}"
# Detect if second argument is URL/port or API key
# Matches: http(s)://..., localhost:..., or :1234
if [[ "${2:-}" =~ ^(https?://|localhost|:[0-9]+) ]]; then
  # Usage: ./query.sh "query" "http://localhost:8787"
  CLI_WORKER_URL="${2}"
else
  # Usage: ./query.sh "query" "api-key" ["worker-url"]
  CLI_API_KEY="${2:-}"
  CLI_WORKER_URL="${3:-}"
fi

API_KEY="${CLI_API_KEY:-${API_KEY}}"

# Set WORKER_URL based on MACHINEN_ENV, unless overridden by CLI arg
case "$MACHINEN_ENV" in
  "dev-justin")
    WORKER_URL_ENV="https://machinen-dev-justin.redwoodjs.workers.dev"
    ;;
  "production")
    WORKER_URL_ENV="https://machinen.redwoodjs.workers.dev"
    ;;
  "local"|*)
    WORKER_URL_ENV="http://localhost:8787"
    ;;
esac

# CLI-provided URL always takes precedence
WORKER_URL="${CLI_WORKER_URL:-${WORKER_URL_ENV}}"

# Normalize WORKER_URL shorthand
if [[ "$WORKER_URL" =~ ^:[0-9]+$ ]]; then
  # Handle ":8787" -> "http://localhost:8787"
  WORKER_URL="http://localhost${WORKER_URL}"
elif [[ "$WORKER_URL" =~ ^localhost:[0-9]+$ ]]; then
  # Handle "localhost:8787" -> "http://localhost:8787"
  WORKER_URL="http://${WORKER_URL}"
fi

# Check required args
if [ -z "$QUERY_OR_PATH" ]; then
  echo "Error: Query or Path is required"
  echo "Usage: $0 \"your query\" [api-key] [worker-url]"
  echo "   or: $0 \"/rag/subjects?query=...\" [api-key] [worker-url]"
  exit 1
fi

if [ -z "$API_KEY" ]; then
  echo "Error: API key is required"
  echo "Usage: $0 \"your query\" \"your-api-key\" [worker-url]"
  echo "Or set API_KEY environment variable"
  exit 1
fi

echo "Querying environment: $MACHINEN_ENV ($WORKER_URL)"
echo "Request: $QUERY_OR_PATH"
echo ""

# Determine if it's a GET or POST based on whether the query starts with a "/"
if [[ "$QUERY_OR_PATH" == /* ]]; then
  # It's a GET request to a specific path
  ENDPOINT_URL="$WORKER_URL$QUERY_OR_PATH"
  RESPONSE=$(curl -s -X GET \
    -H "Authorization: Bearer $API_KEY" \
    "$ENDPOINT_URL")
else
  # It's a POST request to the default /rag/query endpoint
  ENDPOINT_URL="$WORKER_URL/rag/query"
  RESPONSE=$(curl -s -X POST \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"query\": $(echo "$QUERY_OR_PATH" | jq -R .)}" \
    "$ENDPOINT_URL")
fi

# Try to extract .response, but if jq returns null or fails, show raw response
# For subject graph, we want the whole JSON, so we just check for .response field existence
if echo "$RESPONSE" | jq -e '.response' >/dev/null 2>&1; then
  # It's a standard query response, extract the .response field
  EXTRACTED=$(echo "$RESPONSE" | jq -r '.response // empty' 2>/dev/null)
else
  # It's likely a subject graph response or an error, show the whole thing
  EXTRACTED="$RESPONSE"
fi


if [ -z "$EXTRACTED" ] || [ "$EXTRACTED" = "null" ]; then
  # If jq extraction failed or returned null, show the raw response
  echo "$RESPONSE" | jq .
else
  echo "$EXTRACTED"
fi

