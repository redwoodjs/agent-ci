#!/bin/bash

# Query the RAG engine
#
# Usage:
#   ./query.sh "your query here"
#   ./query.sh "your query" "your-api-key"
#   ./query.sh "your query" "your-api-key" "https://your-worker.workers.dev"
#
# Environment variables can also be used:
#   QUERY_API_KEY="your-key" ./query.sh "your query"

# Auto-source .dev.vars if it exists (look in project root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$PROJECT_ROOT/.dev.vars" ]; then
  set -a
  source "$PROJECT_ROOT/.dev.vars"
  set +a
fi

# Parse positional arguments
QUERY="${1:-}"
API_KEY="${2:-${API_KEY:-${QUERY_API_KEY}}}"
WORKER_URL="${3:-${WORKER_URL:-https://rag-experiment-1.redwoodjs.workers.dev}}"

# Check required args
if [ -z "$QUERY" ]; then
  echo "Error: Query is required"
  echo "Usage: $0 \"your query\" [api-key] [worker-url]"
  exit 1
fi

if [ -z "$API_KEY" ]; then
  echo "Error: API key is required"
  echo "Usage: $0 \"your query\" \"your-api-key\" [worker-url]"
  echo "Or set QUERY_API_KEY environment variable"
  exit 1
fi

# URL encode the query for GET request
ENCODED_QUERY=$(printf '%s' "$QUERY" | jq -sRr @uri)

echo "Querying: $QUERY"
echo ""

# GET request (simpler, query in URL)
echo "=== GET Request ==="
curl -X GET \
  -H "Authorization: Bearer $API_KEY" \
  "$WORKER_URL/rag/query?q=$ENCODED_QUERY" \
  | jq '.'

echo ""
echo ""

# POST request (query in JSON body)
echo "=== POST Request ==="
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"query\": $(echo "$QUERY" | jq -R .)}" \
  "$WORKER_URL/rag/query" \
  | jq '.'

