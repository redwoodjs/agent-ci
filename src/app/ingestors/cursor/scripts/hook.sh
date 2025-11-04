#!/bin/bash
set -e

# Read the input from stdin
INPUT=$(cat)

# Define the endpoint URL
ENDPOINT_URL="${CURSOR_INGEST_URL:-http://localhost:5173/ingestors/cursor}"

# Get API key from environment variable
API_KEY="${INGEST_API_KEY}"

if [ -z "$API_KEY" ]; then
  echo "Error: INGEST_API_KEY environment variable is not set" >&2
  exit 1
fi

# Send the data to the endpoint with API key authentication
curl -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d "$INPUT" \
  "$ENDPOINT_URL" > /dev/null 2>&1 &
