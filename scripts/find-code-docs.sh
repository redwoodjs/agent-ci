#!/bin/bash

# Find Code Documents Script
#
# This script helps you find R2 documents (GitHub PRs, issues, Cursor conversations)
# that mention or are related to a specific code file.
#
# Usage:
#   ./scripts/find-code-docs.sh <file-path>
#
# Example:
#   ./scripts/find-code-docs.sh src/app/gh/github-utils.ts

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load API_KEY from .dev.vars
if [ -f "$PROJECT_ROOT/.dev.vars" ]; then
  set -a
  TEMP_VARS=$(mktemp)
  grep -v '^#' "$PROJECT_ROOT/.dev.vars" | grep '=' > "$TEMP_VARS"
  source "$TEMP_VARS"
  rm "$TEMP_VARS"
  set +a
fi

# Default local worker URL
WORKER_URL="${WORKER_URL:-http://localhost:5173}"

if [ -z "$1" ]; then
  echo "Error: File path is required"
  echo "Usage: $0 <file-path>"
  echo "Example: $0 src/app/gh/github-utils.ts"
  exit 1
fi

FILE_PATH="$1"

# Validate API_KEY
if [ -z "$API_KEY" ]; then
  echo "Error: API_KEY is required"
  echo "Set it in .dev.vars or as an environment variable"
  exit 1
fi

echo "Searching for documents related to: $FILE_PATH"
echo ""

# Extract just the filename for a more focused search
FILENAME=$(basename "$FILE_PATH")

# Query the engine to find documents mentioning this file
# We'll use a query that searches for the file path
QUERY="file $FILENAME OR path $FILE_PATH OR code $FILE_PATH"

echo "Querying engine for documents mentioning: $FILE_PATH"
echo ""

RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"query\": $(echo "$QUERY" | jq -R .), \"responseMode\": \"brief\"}" \
  "$WORKER_URL/query")

if [ $? -ne 0 ]; then
  echo "Error: Failed to connect to worker at $WORKER_URL"
  echo "Make sure 'pnpm dev' is running"
  exit 1
fi

# Check if we got a valid response
if echo "$RESPONSE" | jq -e '.error' > /dev/null 2>&1; then
  echo "Error from API:"
  echo "$RESPONSE" | jq -r '.error'
  exit 1
fi

# For now, this is a simple implementation
# In a real scenario, you'd want to parse the response to extract R2 keys
# or use a dedicated search endpoint

echo "Note: This script currently uses the query endpoint to find related documents."
echo "For more precise results, you can:"
echo ""
echo "1. Use the query endpoint directly to find documents:"
echo "   curl -X POST -H 'Authorization: Bearer \$API_KEY' \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"query\": \"$FILE_PATH\"}' \\"
echo "     $WORKER_URL/query"
echo ""
echo "2. Manually search R2 for files that might reference this code:"
echo "   ./scripts/manual-index.mjs github/ | grep -i \"$(basename $FILE_PATH)\""
echo ""
echo "3. For GitHub files, search for PRs/issues in the relevant repo:"
echo "   ./scripts/manual-index.mjs github/owner/repo/"
echo ""

# Return empty for now - the main script will handle the actual finding
# In a future version, this could parse query results or use a search API
echo ""
