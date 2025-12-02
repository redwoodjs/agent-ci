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


# Check for subcommand
MODE="query"
if [[ "$1" == "subjects" ]]; then
  MODE="subjects"
  shift
fi

# Parse positional arguments
QUERY="${1:-}"
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
if [ -z "$QUERY" ]; then
  echo "Error: Query is required"
  echo "Usage: $0 [subjects] \"your query\" [api-key] [worker-url]"
  exit 1
fi

if [ -z "$API_KEY" ]; then
  echo "Error: API key is required"
  echo "Usage: $0 \"your query\" \"your-api-key\" [worker-url]"
  echo "Or set API_KEY environment variable"
  exit 1
fi

echo "Querying environment: $MACHINEN_ENV ($WORKER_URL)"
echo "Mode: $MODE"
echo "Query: $QUERY"
echo ""

if [[ "$MODE" == "subjects" ]]; then
  # It's a GET request to the subjects endpoint
  ENCODED_QUERY=$(echo "$QUERY" | jq -sRr @uri)
  ENDPOINT_URL="$WORKER_URL/rag/subjects?query=$ENCODED_QUERY"
  RESPONSE=$(curl -s -X GET \
    -H "Authorization: Bearer $API_KEY" \
    "$ENDPOINT_URL")
else
  # It's a POST request to the default /rag/query endpoint
  ENDPOINT_URL="$WORKER_URL/rag/query"
RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"query\": $(echo "$QUERY" | jq -R .)}" \
    "$ENDPOINT_URL")
fi

# Pretty-print the JSON response
echo "$RESPONSE" | jq .

