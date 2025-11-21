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

if [ -f "$PROJECT_ROOT/.dev.vars" ]; then
  # Preserve existing environment variables before sourcing .dev.vars
  # Save API_KEY if it exists
  SAVED_API_KEY="${API_KEY:-}"
  
  set -a
  # Filter out comments and lines without =
  source <(grep -v '^#' "$PROJECT_ROOT/.dev.vars" | grep '=')
  set +a
  
  # Restore API_KEY if it was set in the environment before sourcing
  if [ -n "$SAVED_API_KEY" ]; then
    export API_KEY="$SAVED_API_KEY"
  fi
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
WORKER_URL="${CLI_WORKER_URL:-${WORKER_URL:-https://machinen.redwoodjs.workers.dev}}"

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
  echo "Usage: $0 \"your query\" [api-key] [worker-url]"
  exit 1
fi

if [ -z "$API_KEY" ]; then
  echo "Error: API key is required"
  echo "Usage: $0 \"your query\" \"your-api-key\" [worker-url]"
  echo "Or set API_KEY environment variable"
  exit 1
fi

echo "Querying: $QUERY"
echo ""

RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"query\": $(echo "$QUERY" | jq -R .)}" \
  "$WORKER_URL/rag/query")

# Try to extract .response, but if jq returns null or fails, show raw response
EXTRACTED=$(echo "$RESPONSE" | jq -r '.response // empty' 2>/dev/null)

if [ -z "$EXTRACTED" ] || [ "$EXTRACTED" = "null" ]; then
  # If jq extraction failed or returned null, show the raw response
  echo "$RESPONSE"
else
  echo "$EXTRACTED"
fi

