#!/bin/bash

# Test Script for Iteration 1: The Skateboard
# Generates test data, tests end-to-end subject grouping and query filtering, then cleans up

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Load environment variables
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$PROJECT_ROOT/.dev.vars" ]; then
  set -a
  source <(grep -v '^#' "$PROJECT_ROOT/.dev.vars" | grep '=')
  set +a
fi

# Configuration
API_KEY="${API_KEY:-}"
MACHINEN_ENV="${MACHINEN_ENV:-local}"
R2_BUCKET="${R2_BUCKET:-machinen}"
TEST_PREFIX="github/test-subjects"

# Determine worker URL based on environment
case "$MACHINEN_ENV" in
  "dev-justin")
    WORKER_URL="https://machinen-dev-justin.redwoodjs.workers.dev"
    ;;
  "production")
    WORKER_URL="https://machinen.redwoodjs.workers.dev"
    ;;
  "local"|*)
    WORKER_URL="http://localhost:8787"
    ;;
esac

# Generate unique test IDs
TEST_TIMESTAMP=$(date +%s)
TEST_ISSUE_NUM=1000
TEST_PR_NUM=2000
TEST_UNRELATED_ISSUE_NUM=3000

# R2 Keys for test documents
RELATED_ISSUE_KEY="${TEST_PREFIX}/test-repo/issues/${TEST_ISSUE_NUM}/latest.json"
RELATED_PR_KEY="${TEST_PREFIX}/test-repo/pull-requests/${TEST_PR_NUM}/latest.json"
UNRELATED_ISSUE_KEY="${TEST_PREFIX}/test-repo/issues/${TEST_UNRELATED_ISSUE_NUM}/latest.json"

# Functions
log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
  echo -e "${BLUE}[STEP]${NC} $1"
}

check_prerequisites() {
  if [ -z "$API_KEY" ]; then
    log_error "API_KEY is required. Set it in .dev.vars or export it."
    exit 1
  fi

  if ! command -v npx &> /dev/null; then
    log_error "npx is required. Install Node.js"
    exit 1
  fi

  if ! command -v jq &> /dev/null; then
    log_error "jq is required. Install it: brew install jq"
    exit 1
  fi
}

generate_test_issue() {
  local issue_num=$1
  local title=$2
  local body=$3
  local timestamp=$4
  
  cat <<EOF
{
  "github_id": ${issue_num},
  "number": ${issue_num},
  "state": "open",
  "author": "test-user",
  "created_at": "${timestamp}",
  "updated_at": "${timestamp}",
  "title": "${title}",
  "body": "${body}",
  "url": "https://github.com/test-subjects/test-repo/issues/${issue_num}"
}
EOF
}

generate_test_pr() {
  local pr_num=$1
  local title=$2
  local body=$3
  local timestamp=$4
  
  cat <<EOF
{
  "github_id": ${pr_num},
  "number": ${pr_num},
  "state": "open",
  "author": "test-user",
  "created_at": "${timestamp}",
  "updated_at": "${timestamp}",
  "title": "${title}",
  "body": "${body}",
  "url": "https://github.com/test-subjects/test-repo/pull/${pr_num}"
}
EOF
}

upload_to_r2() {
  local r2_key=$1
  local content=$2
  
  log_info "Uploading to R2: $r2_key"
  
  # Create temp file
  local temp_file=$(mktemp)
  echo "$content" > "$temp_file"
  
  # Upload using wrangler
  if npx wrangler r2 object put "${R2_BUCKET}/${r2_key}" --file "$temp_file" --remote > /dev/null 2>&1; then
    log_info "✓ Uploaded successfully"
    rm "$temp_file"
    return 0
  else
    log_error "Failed to upload to R2"
    rm "$temp_file"
    return 1
  fi
}

delete_from_r2() {
  local r2_key=$1
  
  log_info "Deleting from R2: $r2_key"
  
  if npx wrangler r2 object delete "${R2_BUCKET}/${r2_key}" --remote > /dev/null 2>&1; then
    log_info "✓ Deleted successfully"
    return 0
  else
    log_warn "Failed to delete (may not exist): $r2_key"
    return 1
  fi
}

index_document() {
  local r2_key=$1
  log_info "Indexing: $r2_key"
  
  response=$(curl -s -X POST \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"r2Key\": \"$r2_key\"}" \
    "$WORKER_URL/rag/admin/index")
  
  if echo "$response" | jq -e '.success' > /dev/null 2>&1; then
    log_info "✓ Successfully enqueued for indexing"
    return 0
  else
    log_error "Failed to index: $response"
    return 1
  fi
}

wait_for_indexing() {
  log_info "Waiting for indexing to complete (sleeping 15 seconds)..."
  sleep 15
  log_warn "Note: In production, you may need to wait longer or check queue status"
}

query_and_check_subject() {
  local query=$1
  
  log_info "Querying: '$query'"
  
  response=$(curl -s -X POST \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$query\"}" \
    "$WORKER_URL/rag/query")
  
  if echo "$response" | jq -e '.response' > /dev/null 2>&1; then
    log_info "✓ Query succeeded"
    echo ""
    echo "Response:"
    echo "$response" | jq -r '.response' | head -10
    echo ""
    return 0
  else
    log_error "Query failed: $response"
    return 1
  fi
}

cleanup() {
  log_step "Cleaning up test data..."
  
  delete_from_r2 "$RELATED_ISSUE_KEY"
  delete_from_r2 "$RELATED_PR_KEY"
  delete_from_r2 "$UNRELATED_ISSUE_KEY"
  
  log_info "✓ Cleanup complete"
}

# Main test flow
main() {
  log_info "=== Iteration 1 Test: The Skateboard (E2E with Generated Data) ==="
  log_info "Environment: $MACHINEN_ENV ($WORKER_URL)"
  log_info "R2 Bucket: $R2_BUCKET"
  echo ""
  
  check_prerequisites
  
  # Generate timestamps
  TIMESTAMP_ISSUE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  TIMESTAMP_PR=$(date -u -v+1H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "+1 hour" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")
  TIMESTAMP_UNRELATED=$(date -u -v+2H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "+2 hours" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")
  
  # Step 1: Generate and upload test data
  log_step "Step 1: Generating and uploading test data"
  
  RELATED_ISSUE_JSON=$(generate_test_issue \
    "$TEST_ISSUE_NUM" \
    "Fix authentication bug in login flow" \
    "Users are experiencing issues with the login authentication. The bug occurs when users try to log in with OAuth providers. We need to investigate and fix this issue." \
    "$TIMESTAMP_ISSUE")
  
  RELATED_PR_JSON=$(generate_test_pr \
    "$TEST_PR_NUM" \
    "Fix OAuth login authentication bug" \
    "This PR fixes the authentication bug mentioned in #${TEST_ISSUE_NUM}. The issue was in the token validation logic. Changes include: 1) Updated token validation, 2) Added error handling, 3) Improved logging. Closes #${TEST_ISSUE_NUM}" \
    "$TIMESTAMP_PR")
  
  UNRELATED_ISSUE_JSON=$(generate_test_issue \
    "$TEST_UNRELATED_ISSUE_NUM" \
    "Add dark mode theme support" \
    "We should add a dark mode theme option for better user experience. This is a feature request for UI improvements." \
    "$TIMESTAMP_UNRELATED")
  
  upload_to_r2 "$RELATED_ISSUE_KEY" "$RELATED_ISSUE_JSON"
  upload_to_r2 "$RELATED_PR_KEY" "$RELATED_PR_JSON"
  upload_to_r2 "$UNRELATED_ISSUE_KEY" "$UNRELATED_ISSUE_JSON"
  
  echo ""
  
  # Step 2: Index related documents
  log_step "Step 2: Indexing related documents"
  index_document "$RELATED_ISSUE_KEY"
  index_document "$RELATED_PR_KEY"
  wait_for_indexing
  
  # Step 3: Index unrelated document
  log_step "Step 3: Indexing unrelated document"
  index_document "$UNRELATED_ISSUE_KEY"
  wait_for_indexing
  
  # Step 4: Query that should find the related subject
  log_step "Step 4: Testing query (should find related subject)"
  query_and_check_subject "What is the authentication bug issue about?"
  
  # Step 5: Query that should NOT find the unrelated document
  log_step "Step 5: Testing query (should NOT find unrelated document)"
  query_and_check_subject "Tell me about the OAuth login fix"
  
  # Step 6: Validation checklist
  log_step "Step 6: Manual Validation Checklist"
  echo ""
  echo "Please verify the following:"
  echo "  1. Check worker logs - both related documents should have the SAME subjectId"
  echo "  2. Check worker logs - unrelated document should have a DIFFERENT subjectId"
  echo "  3. Check SUBJECT_INDEX - should contain 2 subjects (one for related pair, one for unrelated)"
  echo "  4. Check VECTORIZE_INDEX - chunks should have subjectId metadata matching their documents"
  echo "  5. Query responses should be filtered by subjectId (check logs for filter application)"
  echo ""
  
  # Step 7: Cleanup
  log_step "Step 7: Cleanup"
  read -p "Press Enter to clean up test data (or Ctrl+C to keep it for inspection)..."
  cleanup
  
  log_info "=== Test Complete ==="
  log_warn "Review the validation checklist above and worker logs to confirm success"
}

# Trap to ensure cleanup on exit
trap cleanup EXIT

# Run main
main "$@"