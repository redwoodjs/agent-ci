#!/bin/bash
set -e

# Read the input from stdin
INPUT=$(cat)

# Define the endpoint URL
ENDPOINT_URL="http://localhost:5173/ingestors/cursor"

# Send the data to the endpoint
curl -X POST -H "Content-Type: application/json" -d "$INPUT" "$ENDPOINT_URL" > /dev/null 2>&1 &
