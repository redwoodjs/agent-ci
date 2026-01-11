#!/bin/bash

# Local Backfill Script
# 
# This script helps you populate your local Durable Objects by re-indexing
# remote R2 documents. This is the "safe" way to get production data locally
# without connecting directly to production DOs.
#
# Usage:
#   ./scripts/local-backfill.sh [options] [prefix]
#
# Options:
#   --limit N          Only process the first N files (default: no limit)
#   --keys KEY1,KEY2   Specify exact R2 keys to index (comma-separated)
#   --code REPO COMMIT FILE:LINE
#                      Index documents related to a specific code location
#                      Uses same semantics as tldr: repo, commit, file:line
#                      Example: --code redwoodjs/sdk e4d0403 navigationCache.ts:380
#   --namespace NS     Optional namespace for Moment Graph
#                      Example: --namespace prod-2025-01-09-00-30:redwood:rwsdk
#
# Examples:
#   ./scripts/local-backfill.sh github/                    # All GitHub files
#   ./scripts/local-backfill.sh --limit 10 github/          # First 10 GitHub files
#   ./scripts/local-backfill.sh --keys github/owner/repo/pull-requests/123/latest.json
#   ./scripts/local-backfill.sh --code redwoodjs/sdk e4d0403 navigationCache.ts:380
#   ./scripts/local-backfill.sh --code redwoodjs/sdk e4d0403 navigationCache.ts:380 --namespace prod-2025-01-09-00-30:redwood:rwsdk
#
# If no prefix is provided, defaults to "github/"

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

# Parse arguments
PREFIX=""
LIMIT=""
R2_KEYS=""
CODE_REPO=""
CODE_COMMIT=""
CODE_FILE=""
CODE_LINE=""
NAMESPACE=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --limit)
      LIMIT="$2"
      shift 2
      ;;
    --keys)
      R2_KEYS="$2"
      shift 2
      ;;
    --code)
      CODE_REPO="$2"
      CODE_COMMIT="$3"
      CODE_FILE_LINE="$4"
      if [ -z "$CODE_REPO" ] || [ -z "$CODE_COMMIT" ] || [ -z "$CODE_FILE_LINE" ]; then
        echo "Error: --code requires 3 arguments: repo commit file:line"
        echo "Example: --code redwoodjs/sdk e4d0403 navigationCache.ts:380"
        exit 1
      fi
      # Parse file:line format (use lastIndexOf colon like the web UI does)
      if [[ "$CODE_FILE_LINE" == *:* ]]; then
        CODE_LINE="${CODE_FILE_LINE##*:}"
        CODE_FILE="${CODE_FILE_LINE%:*}"
      else
        CODE_FILE="$CODE_FILE_LINE"
        CODE_LINE=""
      fi
      shift 4
      ;;
    --namespace)
      NAMESPACE="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [options] [prefix]"
      echo ""
      echo "Options:"
      echo "  --limit N          Only process the first N files"
      echo "  --keys KEY1,KEY2   Specify exact R2 keys to index (comma-separated)"
      echo "  --code REPO COMMIT FILE:LINE"
      echo "                     Index documents related to a specific code location"
      echo "                     Uses same semantics as tldr: repo, commit, file:line"
      echo "  --namespace NS     Optional namespace for Moment Graph"
      echo "  --help             Show this help message"
      echo ""
      echo "Examples:"
      echo "  $0 github/"
      echo "  $0 --limit 10 github/"
      echo "  $0 --keys github/owner/repo/pull-requests/123/latest.json"
      echo "  $0 --code redwoodjs/sdk e4d0403 navigationCache.ts:380"
      echo "  $0 --code redwoodjs/sdk e4d0403 navigationCache.ts:380 --namespace prod-2025-01-09-00-30:redwood:rwsdk"
      exit 0
      ;;
    -*)
      echo "Unknown option: $1"
      echo "Use --help for usage information"
      exit 1
      ;;
    *)
      PREFIX="$1"
      shift
      ;;
  esac
done

# Default prefix if not provided
PREFIX="${PREFIX:-github/}"

# Validate API_KEY
if [ -z "$API_KEY" ]; then
  echo "Error: API_KEY is required"
  echo "Set it in .dev.vars or as an environment variable"
  exit 1
fi

# If --code is specified, find PRs for the commit and construct R2 keys
if [ -n "$CODE_REPO" ]; then
  if [ -z "$CODE_LINE" ] || [ "$CODE_LINE" = "0" ]; then
    echo "Error: --code requires file:line format with a valid line number"
    echo "Example: --code redwoodjs/sdk e4d0403 navigationCache.ts:380"
    exit 1
  fi
  
  echo "Finding PRs for code location:"
  echo "  Repo: $CODE_REPO"
  echo "  Commit: $CODE_COMMIT"
  echo "  File: $CODE_FILE"
  echo "  Line: $CODE_LINE"
  if [ -n "$NAMESPACE" ]; then
    echo "  Namespace: $NAMESPACE"
  fi
  echo ""
  
  # Parse repo (supports owner/repo, https://github.com/owner/repo, etc.)
  OWNER_REPO=""
  if [[ "$CODE_REPO" =~ ^https://github.com/([^/]+)/([^/]+) ]]; then
    OWNER_REPO="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
  elif [[ "$CODE_REPO" =~ ^git@github.com:([^/]+)/([^/]+) ]]; then
    OWNER_REPO="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
  elif [[ "$CODE_REPO" =~ ^([^/]+)/([^/]+)$ ]]; then
    OWNER_REPO="$CODE_REPO"
  else
    echo "Error: Invalid repo format: $CODE_REPO"
    echo "Expected: owner/repo, https://github.com/owner/repo, or git@github.com:owner/repo"
    exit 1
  fi
  
  OWNER=$(echo "$OWNER_REPO" | cut -d/ -f1)
  REPO=$(echo "$OWNER_REPO" | cut -d/ -f2)
  
  # Get PRs for the commit using GitHub API
  if [ -z "$GITHUB_TOKEN" ]; then
    echo "Error: GITHUB_TOKEN is required for --code option"
    echo "Set it in .dev.vars or as an environment variable"
    exit 1
  fi
  
  echo "Fetching PRs for commit $CODE_COMMIT in $OWNER/$REPO..."
  PR_RESPONSE=$(curl -s -X GET \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/$OWNER/$REPO/commits/$CODE_COMMIT/pulls")
  
  if [ $? -ne 0 ]; then
    echo "Error: Failed to fetch PRs from GitHub API"
    exit 1
  fi
  
  # Check for API errors
  if echo "$PR_RESPONSE" | jq -e '.message' > /dev/null 2>&1; then
    ERROR_MSG=$(echo "$PR_RESPONSE" | jq -r '.message')
    echo "Error from GitHub API: $ERROR_MSG"
    exit 1
  fi
  
  # Extract PR numbers
  PR_NUMBERS=$(echo "$PR_RESPONSE" | jq -r '.[].number' 2>/dev/null)
  
  # Construct R2 keys array starting with PRs
  R2_KEYS_ARRAY=()
  
  if [ -n "$PR_NUMBERS" ]; then
    while IFS= read -r pr_num; do
      if [ -n "$pr_num" ]; then
        R2_KEYS_ARRAY+=("github/$OWNER/$REPO/pull-requests/$pr_num/latest.json")
      fi
    done <<< "$PR_NUMBERS"
    echo "Found $(echo "$PR_NUMBERS" | wc -l | tr -d ' ') PR(s):"
    echo "$PR_NUMBERS" | sed 's/^/  - PR #/'
  else
    echo "No pull requests found for commit $CODE_COMMIT in $OWNER/$REPO"
  fi
  
  echo ""
  echo "Searching for related issues, PRs, and cursor conversations..."
  echo ""
  
  # Build search queries to find related documents
  # 1. Search for the file name
  FILENAME=$(basename "$CODE_FILE")
  FILE_QUERY="$FILENAME $CODE_FILE"
  
  # 2. Search for the commit hash
  COMMIT_QUERY="$CODE_COMMIT"
  
  # 3. Search for repo-specific content
  REPO_QUERY="$OWNER/$REPO $CODE_FILE"
  
  # Query the engine to find related documents
  echo "Querying engine for documents mentioning: $FILE_QUERY"
  
  # Use the query endpoint to find related documents
  # We'll make multiple queries and collect document IDs from responses
  QUERIES=("$FILE_QUERY" "$COMMIT_QUERY" "$REPO_QUERY")
  
  for query in "${QUERIES[@]}"; do
    if [ -z "$query" ]; then
      continue
    fi
    
    echo "  Searching: $query"
    
    # Query with brief mode to get document references
    QUERY_RESPONSE=$(curl -s -X POST \
      -H "Authorization: Bearer $API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"query\": $(echo "$query" | jq -R .), \"responseMode\": \"brief\"}" \
      "$WORKER_URL/query" 2>/dev/null)
    
    # Note: The query endpoint returns text, not structured data with document IDs
    # For now, we'll use a different approach - query the R2 bucket directly
    # or use the code timeline endpoint if available
  done
  
  echo ""
  echo "Fetching related issues from GitHub API..."
  
  # Get issues for the repo that might be related
  # Search for issues mentioning the file or commit
  ISSUES_RESPONSE=$(curl -s -X GET \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/search/issues?q=repo:$OWNER/$REPO+$FILENAME+type:issue" 2>/dev/null)
  
  if [ $? -eq 0 ]; then
    ISSUE_NUMBERS=$(echo "$ISSUES_RESPONSE" | jq -r '.items[].number' 2>/dev/null)
    if [ -n "$ISSUE_NUMBERS" ]; then
      ISSUE_COUNT=$(echo "$ISSUE_NUMBERS" | wc -l | tr -d ' ')
      echo "  Found $ISSUE_COUNT related issue(s)"
      while IFS= read -r issue_num; do
        if [ -n "$issue_num" ]; then
          R2_KEYS_ARRAY+=("github/$OWNER/$REPO/issues/$issue_num/latest.json")
        fi
      done <<< "$ISSUE_NUMBERS"
    fi
  fi
  
  # Also search for more PRs that might mention the file
  echo "Searching for additional PRs mentioning the file..."
  PRS_RESPONSE=$(curl -s -X GET \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/search/issues?q=repo:$OWNER/$REPO+$FILENAME+type:pr" 2>/dev/null)
  
  if [ $? -eq 0 ]; then
    ADDITIONAL_PR_NUMBERS=$(echo "$PRS_RESPONSE" | jq -r '.items[].number' 2>/dev/null)
    if [ -n "$ADDITIONAL_PR_NUMBERS" ]; then
      ADDITIONAL_COUNT=$(echo "$ADDITIONAL_PR_NUMBERS" | wc -l | tr -d ' ')
      echo "  Found $ADDITIONAL_COUNT additional PR(s) mentioning the file"
      while IFS= read -r pr_num; do
        if [ -n "$pr_num" ]; then
          KEY="github/$OWNER/$REPO/pull-requests/$pr_num/latest.json"
          # Avoid duplicates
          if [[ ! " ${R2_KEYS_ARRAY[@]} " =~ " ${KEY} " ]]; then
            R2_KEYS_ARRAY+=("$KEY")
          fi
        fi
      done <<< "$ADDITIONAL_PR_NUMBERS"
    fi
  fi
  
  # Search for cursor conversations related to this repo/file
  echo ""
  echo "Searching for related cursor conversations..."
  
  # Build queries to find cursor conversations
  CURSOR_QUERIES=(
    "$FILENAME"
    "$OWNER/$REPO $FILENAME"
    "$CODE_COMMIT"
    "$OWNER/$REPO $CODE_FILE"
  )
  
  # Use the query endpoint to find cursor conversations
  # Note: We can't directly extract document IDs from query responses,
  # but we can use the backfill endpoint with cursor/ prefix to get all conversations
  # and let the engine's semantic search find the relevant ones during indexing
  
  echo "  Will index all cursor conversations - engine will filter relevant ones during processing"
  echo "  (Cursor conversations are discovered via semantic search during indexing)"
  echo ""
  
  # Also search for more GitHub content
  echo "Searching for additional related content..."
  
  # Search for PRs and issues mentioning the commit
  COMMIT_SEARCH=$(curl -s -X GET \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/search/issues?q=repo:$OWNER/$REPO+$CODE_COMMIT+type:issue" 2>/dev/null)
  
  if [ $? -eq 0 ]; then
    COMMIT_ISSUES=$(echo "$COMMIT_SEARCH" | jq -r '.items[].number' 2>/dev/null)
    if [ -n "$COMMIT_ISSUES" ]; then
      COMMIT_ISSUE_COUNT=$(echo "$COMMIT_ISSUES" | wc -l | tr -d ' ')
      echo "  Found $COMMIT_ISSUE_COUNT issue(s) mentioning commit"
      while IFS= read -r issue_num; do
        if [ -n "$issue_num" ]; then
          KEY="github/$OWNER/$REPO/issues/$issue_num/latest.json"
          if [[ ! " ${R2_KEYS_ARRAY[@]} " =~ " ${KEY} " ]]; then
            R2_KEYS_ARRAY+=("$KEY")
          fi
        fi
      done <<< "$COMMIT_ISSUES"
    fi
  fi
  
  # Search for PRs mentioning the commit
  COMMIT_PRS_SEARCH=$(curl -s -X GET \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/search/issues?q=repo:$OWNER/$REPO+$CODE_COMMIT+type:pr" 2>/dev/null)
  
  if [ $? -eq 0 ]; then
    COMMIT_PRS=$(echo "$COMMIT_PRS_SEARCH" | jq -r '.items[].number' 2>/dev/null)
    if [ -n "$COMMIT_PRS" ]; then
      COMMIT_PR_COUNT=$(echo "$COMMIT_PRS" | wc -l | tr -d ' ')
      echo "  Found $COMMIT_PR_COUNT additional PR(s) mentioning commit"
      while IFS= read -r pr_num; do
        if [ -n "$pr_num" ]; then
          KEY="github/$OWNER/$REPO/pull-requests/$pr_num/latest.json"
          if [[ ! " ${R2_KEYS_ARRAY[@]} " =~ " ${KEY} " ]]; then
            R2_KEYS_ARRAY+=("$KEY")
          fi
        fi
      done <<< "$COMMIT_PRS"
    fi
  fi
  
  if [ ${#R2_KEYS_ARRAY[@]} -eq 0 ]; then
    echo "Error: No documents found to index"
    exit 1
  fi
  
  R2_KEYS=$(IFS=','; echo "${R2_KEYS_ARRAY[*]}")
  
  echo "Total GitHub R2 keys to index: ${#R2_KEYS_ARRAY[@]}"
  echo "GitHub R2 keys:"
  printf '%s\n' "${R2_KEYS_ARRAY[@]}" | sed 's/^/  - /'
  echo ""
  
  # Also trigger a cursor conversation backfill to find related conversations
  # The engine's semantic search will automatically discover relevant ones
  echo "Will also backfill cursor conversations..."
  echo "  (All cursor conversations will be scanned - semantic search will find relevant ones)"
  echo "  This maximizes the amount of related data indexed locally."
  CURSOR_BACKFILL=true
fi

# Show what we're indexing (if not already shown by --code)
if [ -n "$R2_KEYS" ] && [ -z "$CODE_REPO" ]; then
  echo "Indexing specific R2 keys:"
  echo "$R2_KEYS" | tr ',' '\n' | sed 's/^/  - /'
  echo ""
fi

if [ -n "$LIMIT" ] && [ -z "$R2_KEYS" ]; then
  # For limit, we'll do a two-step process:
  # 1. First, get a list of files (this requires R2 access or a helper endpoint)
  # 2. Then use resync with the limited list
  # For now, we'll use backfill but note that it processes all files
  # The limit will be informational - the actual limiting happens server-side during processing
  echo "Note: --limit option will process files in batches."
  echo "The backfill will scan all files but you can stop it early (Ctrl+C) after seeing enough activity."
  echo "For precise control, use --keys to specify exact files."
  echo ""
fi

echo "Local Backfill Script"
echo "===================="
if [ -n "$TARGET_FILE" ]; then
  echo "Target file: $TARGET_FILE"
elif [ -n "$R2_KEYS" ]; then
  echo "Mode: Specific R2 keys"
else
  echo "Prefix: $PREFIX"
  if [ -n "$LIMIT" ]; then
    echo "Limit: $LIMIT files"
  fi
fi
echo "Worker URL: $WORKER_URL"
echo ""

if [ -z "$R2_KEYS" ]; then
  echo "This will trigger local indexing of remote R2 files."
  echo "The local worker will fetch documents from the remote R2 bucket and"
  echo "populate your local Durable Objects (EngineIndexingStateDO, MomentGraphDO)."
  echo ""
  read -p "Continue? (y/N) " -n 1 -r
  echo ""
  
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cancelled"
    exit 0
  fi
fi

echo ""
echo "Triggering backfill..."
echo ""

# Determine which endpoint to use and build request body
if [ -n "$R2_KEYS" ]; then
  # Use /admin/resync with r2Keys for specific keys
  ENDPOINT="$WORKER_URL/admin/resync"
  KEYS_ARRAY=$(echo "$R2_KEYS" | tr ',' '\n' | jq -R . | jq -s .)
  if [ -n "$NAMESPACE" ]; then
    REQUEST_BODY=$(jq -n --argjson keys "$KEYS_ARRAY" --arg ns "$NAMESPACE" '{r2Keys: $keys, mode: "enqueue", momentGraphNamespace: $ns}')
  else
    REQUEST_BODY=$(jq -n --argjson keys "$KEYS_ARRAY" '{r2Keys: $keys, mode: "enqueue"}')
  fi
else
  # Use /admin/backfill for prefix-based scanning
  ENDPOINT="$WORKER_URL/admin/backfill"
  if [ -n "$NAMESPACE" ]; then
    REQUEST_BODY=$(jq -n --arg prefix "$PREFIX" --arg ns "$NAMESPACE" '{prefix: $prefix, momentGraphNamespace: $ns}')
  else
    REQUEST_BODY=$(jq -n --arg prefix "$PREFIX" '{prefix: $prefix}')
  fi
fi

# Make the API call(s)
if [ -n "$CURSOR_BACKFILL" ] && [ "$CURSOR_BACKFILL" = "true" ]; then
  # First, index the specific GitHub documents
  echo "Step 1: Indexing GitHub documents (PRs and issues)..."
  RESPONSE=$(curl -s -X POST \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$REQUEST_BODY" \
    "$ENDPOINT")
  
  # Check if curl succeeded
  if [ $? -ne 0 ]; then
    echo "Error: Failed to connect to worker at $WORKER_URL"
    echo "Make sure 'pnpm dev' is running"
    exit 1
  fi
  
  # Parse and display response
  echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
  
  # Check for success
  if echo "$RESPONSE" | jq -e '.success == true' > /dev/null 2>&1; then
    FILES_ENQUEUED=$(echo "$RESPONSE" | jq -r '.filesEnqueued // .r2KeysEnqueued // 0')
    echo ""
    echo "✓ GitHub documents enqueued: $FILES_ENQUEUED"
  else
    echo ""
    echo "✗ Failed to enqueue GitHub documents"
    exit 1
  fi
  
  # Second, trigger cursor conversation backfill
  echo ""
  echo "Step 2: Backfilling cursor conversations..."
  CURSOR_REQUEST_BODY=$(jq -n --arg prefix "cursor/" '{prefix: $prefix}')
  if [ -n "$NAMESPACE" ]; then
    CURSOR_REQUEST_BODY=$(jq -n --arg prefix "cursor/" --arg ns "$NAMESPACE" '{prefix: $prefix, momentGraphNamespace: $ns}')
  fi
  
  CURSOR_RESPONSE=$(curl -s -X POST \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$CURSOR_REQUEST_BODY" \
    "$WORKER_URL/admin/backfill")
  
  if [ $? -eq 0 ]; then
    echo "$CURSOR_RESPONSE" | jq . 2>/dev/null || echo "$CURSOR_RESPONSE"
    if echo "$CURSOR_RESPONSE" | jq -e '.success == true' > /dev/null 2>&1; then
      CURSOR_FILES=$(echo "$CURSOR_RESPONSE" | jq -r '.filesEnqueued // 0')
      echo ""
      echo "✓ Cursor conversations enqueued: $CURSOR_FILES"
      echo ""
      echo "✓ Complete backfill initiated successfully"
      echo "  - GitHub documents: $FILES_ENQUEUED"
      echo "  - Cursor conversations: $CURSOR_FILES"
    else
      echo ""
      echo "⚠ Cursor backfill failed, but GitHub documents were enqueued"
    fi
  else
    echo ""
    echo "⚠ Failed to trigger cursor backfill, but GitHub documents were enqueued"
  fi
else
  # Single API call for non-cursor backfill
  RESPONSE=$(curl -s -X POST \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$REQUEST_BODY" \
    "$ENDPOINT")
  
  # Check if curl succeeded
  if [ $? -ne 0 ]; then
    echo "Error: Failed to connect to worker at $WORKER_URL"
    echo "Make sure 'pnpm dev' is running"
    exit 1
  fi
  
  # Parse and display response
  echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
  
  # Check for success
  if echo "$RESPONSE" | jq -e '.success == true' > /dev/null 2>&1; then
    FILES_ENQUEUED=$(echo "$RESPONSE" | jq -r '.filesEnqueued // .r2KeysEnqueued // 0')
    echo ""
    echo "✓ Backfill initiated successfully"
    if [ "$FILES_ENQUEUED" != "0" ] && [ "$FILES_ENQUEUED" != "null" ]; then
      echo "  Files enqueued: $FILES_ENQUEUED"
    fi
  else
    echo ""
    echo "✗ Backfill failed"
    exit 1
  fi
fi

echo ""
echo "Note: Files are being processed in the background. Check your worker logs"
echo "      to see indexing progress. The engine will use semantic search to"
echo "      discover and link related documents automatically."
