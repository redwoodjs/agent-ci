#!/bin/bash

# Test script to verify subjects are working correctly
# This script helps validate that subject correlation and filtering is functioning
#
# Usage:
#   ./scripts/test-subjects.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load environment from .dev.vars
if [ -f "$PROJECT_ROOT/.dev.vars" ]; then
  set -a
  TEMP_VARS=$(mktemp)
  grep -v '^#' "$PROJECT_ROOT/.dev.vars" | grep '=' > "$TEMP_VARS"
  source "$TEMP_VARS"
  rm "$TEMP_VARS"
  set +a
fi

MACHINEN_ENV="${MACHINEN_ENV:-local}"

case "$MACHINEN_ENV" in
  "dev-justin-2")
    WORKER_URL="https://machinen-dev-justin-2.redwoodjs.workers.dev"
    ;;
  "production")
    WORKER_URL="https://machinen.redwoodjs.workers.dev"
    ;;
  "local"|*)
    WORKER_URL="http://localhost:8787"
    ;;
esac

if [ -z "$API_KEY" ]; then
  echo "Error: API_KEY is required"
  echo "Set it in .dev.vars or as an environment variable"
  exit 1
fi

echo "=========================================="
echo "Testing Subject Correlation & Filtering"
echo "=========================================="
echo "Environment: $MACHINEN_ENV"
echo "Worker URL: $WORKER_URL"
echo ""
echo "IMPORTANT: To test subjects, you need to query about topics that"
echo "have been indexed. Subjects are created from document titles."
echo ""
echo "To find what's been indexed:"
echo "1. Check the audit dashboard: $WORKER_URL/audit/indexing-status"
echo "2. Look for GitHub issues/PRs that have been indexed"
echo "3. Query using those titles or topics"
echo ""
echo "This script tests that:"
echo "1. Subjects are found for queries"
echo "2. Results are filtered by subjectId"
echo "3. Unrelated queries return different/empty results"
echo ""
echo "Watch the logs (./scripts/tail-logs.sh) to see:"
echo "- '[query] Found subject: <subjectId>' or 'No subject found'"
echo "- '[query] Added subjectId filter: <subjectId>'"
echo "- '[query] Found X search results'"
echo ""
echo "=========================================="
echo ""
echo "Enter a query about a topic that should have been indexed:"
echo "(e.g., a GitHub issue/PR title, or topic from Discord/Cursor)"
read -p "Query 1: " QUERY1

if [ -z "$QUERY1" ]; then
  echo "No query provided, using default..."
  QUERY1="What is the knowledge synthesis engine?"
fi

echo ""
echo "Test 1: Query about a specific topic (should find a subject)"
echo "Query: '$QUERY1'"
echo "---"
./scripts/query.sh "$QUERY1"
echo ""
echo "Check logs for: Found subject: <subjectId>"
echo ""
read -p "Press Enter to continue..."

echo ""
echo "Enter a DIFFERENT query (should find a different subject or none):"
read -p "Query 2: " QUERY2

if [ -z "$QUERY2" ]; then
  echo "No query provided, using default..."
  QUERY2="How do I deploy to production?"
fi

echo ""
echo "Test 2: Query about something different (should find different/empty results)"
echo "Query: '$QUERY2'"
echo "---"
./scripts/query.sh "$QUERY2"
echo ""
echo "Check logs for: Different subjectId or 'No subject found'"
echo ""
read -p "Press Enter to continue..."

echo ""
echo "Test 3: Query same topic again (should find same subject)"
echo "Query: '$QUERY1'"
echo "---"
./scripts/query.sh "$QUERY1"
echo ""
echo "Check logs for: Same subjectId as Test 1"
echo ""
echo "=========================================="
echo "Manual Validation Checklist:"
echo "=========================================="
echo "✓ Logs show '[query] Found subject: <subjectId>' for Test 1"
echo "✓ Logs show '[query] Added subjectId filter: <subjectId>'"
echo "✓ Logs show filter clauses include subjectId"
echo "✓ Test 1 and Test 3 find the same subjectId"
echo "✓ Test 2 finds a different subjectId or no subject"
echo "✓ Results are filtered (only chunks from that subject)"
echo ""
echo "If subjects are working correctly:"
echo "- Related queries should find the same subject"
echo "- Unrelated queries should find different subjects or none"
echo "- Results should be filtered to only chunks from the found subject"
echo "- If no subject found, all chunks are searched (no filtering)"
echo ""

